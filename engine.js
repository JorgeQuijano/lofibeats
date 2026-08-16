// lofibeats engine — synthesizes lo-fi in the browser, seeded by 3-min time buckets
// so every listener in the same bucket hears the same stream.
(() => {
  'use strict';

  const BUCKET_MS = 3 * 60 * 1000;          // 3 minutes per "song"
  const EIGHT_BARS_BEATS = 32;             // 8 bars * 4/4
  const LOOP_DELAY = 0.05;                 // scheduling lookahead (s)

  // ---- seeded RNG (mulberry32) --------------------------------------------
  function seedFromBucket(bucket) {
    // mix timestamp bucket with a fixed namespace so seeds are stable across loads
    let h = 2166136261 ^ 0x9e3779b9;
    const s = String(bucket);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function range(rng, lo, hi) { return lo + (hi - lo) * rng(); }

  // ---- music theory --------------------------------------------------------
  // jazz-leaning: major7, m7, 9, m9, sus
  const ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const CHORD_TYPES = ['maj7', 'm7', 'm9', '9', '7sus4'];
  // ii-V-I-ish and modal vamps, plus minor relatives
  const PROGRESSIONS = [
    ['Imaj7', 'vi7', 'ii7', 'V7'],   // classic I-vi-ii-V
    ['i7', 'iv7', 'VII7', 'III7'],   // minor, modal
    ['Imaj7', 'IVmaj7', 'iii7', 'vi7'],
    ['ii7', 'V7', 'Imaj7', 'Imaj7'], // turnaround
    ['Imaj9', 'IV9', 'iii7', 'VIsus'],
    ['i9', 'VImaj7', 'iv9', 'V7alt'],
  ];

  function midiFor(root, octave = 4) {
    const idx = ROOT_NAMES.indexOf(root);
    return 12 * (octave + 1) + idx;
  }

  function chordNotes(root, type, octave = 4) {
    const r = midiFor(root, octave);
    const intervals = {
      maj7: [0, 4, 7, 11],
      m7:   [0, 3, 7, 10],
      m9:   [0, 3, 7, 10, 14],
      '9':  [0, 4, 7, 10, 14],
      '7sus4': [0, 5, 7, 10],
      '7':  [0, 4, 7, 10],
      '7alt':[0, 4, 10, 13],
      IVmaj7:[0, 5, 7, 11],
      VIsus:[0, 7, 10, 16],
    }[type] || [0, 4, 7, 11];
    return intervals.map(i => Tone.Frequency(r + i, "midi").toFrequency());
  }

  // Roman -> chord function: gives root + type
  function romanToChord(roman, keyRoot) {
    const k = ROOT_NAMES.indexOf(keyRoot);
    const offsets = { I: 0, i: 0, ii: 2, II: 2, iii: 4, III: 4, IV: 5, iv: 5, V: 7, v: 7, VI: 9, vi: 9, VII: 11, vii: 11 };
    const isMinor = roman === roman.toLowerCase();
    const base = roman.match(/^[ivxIVX]+/)[0].toLowerCase();
    const degree = offsets[base];
    const root = ROOT_NAMES[(k + degree) % 12];
    let type;
    if (base === 'V' && !isMinor) type = '7';
    else if (base === 'vii' && isMinor) type = '7alt';
    else if (base === 'IV' && !isMinor && roman.includes('maj')) type = 'IVmaj7';
    else if (base === 'VI' && roman.includes('sus')) type = 'VIsus';
    else if (isMinor) type = roman.includes('9') ? 'm9' : 'm7';
    else type = roman.endsWith('maj7') ? 'maj7' : (roman.includes('9') ? '9' : 'maj7');
    return { root, type };
  }

  // ---- noise / randomness --------------------------------------------------
  function whiteNoiseBuffer(seconds = 2) {
    const buf = Tone.context.createBuffer(1, seconds * Tone.context.sampleRate, Tone.context.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1);
    return buf;
  }

  // ---- synth voices --------------------------------------------------------
  function buildPiano() {
    // slightly detuned fm-keys for warmth + cheap "felt piano" vibe
    return new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 1.0,
      modulationIndex: 2,
      oscillator: { type: "sine" },
      envelope: { attack: 0.01, decay: 0.4, sustain: 0.2, release: 1.6 },
      modulation: { type: "sine" },
      modulationEnvelope: { attack: 0.01, decay: 0.3, sustain: 0, release: 0.4 },
    }).toDestination();
  }

  function buildSax() {
    // sawtooth + lowpass + slight growl -> breathy sax-ish
    const synth = new Tone.Synth({
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.04, decay: 0.2, sustain: 0.4, release: 0.6 },
    });
    const filter = new Tone.Filter(900, "lowpass");
    const lfo = new Tone.LFO("4Hz", 800, 1500);
    lfo.connect(filter.frequency);
    lfo.start();
    synth.connect(filter);
    return { synth, output: filter };
  }

  function buildBass() {
    return new Tone.MonoSynth({
      oscillator: { type: "triangle" },
      filter: { type: "lowpass", frequency: 600, Q: 4 },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3, baseFrequency: 200, octaves: 2.5 },
    }).toDestination();
  }

  function buildDrums() {
    const kick = new Tone.MembraneSynth({
      pitchDecay: 0.04, octaves: 6,
      envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.4 },
    }).toDestination();
    const snare = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.18, sustain: 0 },
      filterEnvelope: { attack: 0.001, decay: 0.1, sustain: 0, baseFrequency: 1500, octaves: 2 },
    }).toDestination();
    const hat = new Tone.MetalSynth({
      frequency: 8000,
      envelope: { attack: 0.001, decay: 0.06, release: 0.05 },
      harmonicity: 5.1,
      modulationIndex: 2,
      resonance: 4000,
      octaves: 1.5,
    }).toDestination();
    // tame the metal synth a bit
    const hatGain = new Tone.Gain(0.18).toDestination();
    hat.disconnect(); hat.connect(hatGain);
    return { kick, snare, hat, hatGain };
  }

  function buildVinyl() {
    const src = new Tone.BufferSource(whiteNoiseBuffer(4));
    src.loop = true;
    src.start();
    const bp = new Tone.Filter(2000, "bandpass").toDestination();
    const g = new Tone.Gain(0.0).toDestination();
    src.connect(bp); bp.connect(g);
    return { src, g };
  }

  // ---- per-bucket pattern generator --------------------------------------
  function generatePattern(bucket) {
    const rng = mulberry32(seedFromBucket(bucket));
    const rootKey = pick(rng, ROOT_NAMES);
    const scale = pick(rng, ['major', 'minor']);
    const progression = pick(rng, PROGRESSIONS).map(r => {
      const minorRoot = scale === 'minor' ? r.toLowerCase() : r;
      return romanToChord(minorRoot, rootKey);
    });
    const swing = range(rng, 0.55, 0.65);              // 0.5 = straight, 0.6 = swung
    const tempo = Math.round(range(rng, 70, 88));
    const drumDensity = pick(rng, ['sparse', 'normal', 'bouncy']);
    return {
      seed: bucket,
      rng,
      rootKey,
      scale,
      progression,
      swing,
      tempo,
      drumDensity,
      includeSax: rng() < 0.45,
    };
  }

  // ---- sequence helpers ----------------------------------------------------
  // We schedule events at absolute seconds offset from a "loop start" anchor.
  // Tone.Transport drives the BPM; Loop repeats every 8 bars (~16-22s at our tempos).
  // To avoid "scheduled in the past" errors, we always compute times as
  //   loopStartTime + beatsToSeconds(... since loopStart)
  // and re-arm the next loop before the current one expires (lookahead 4s).
  function beatsToSeconds(beats, bpm) { return (60 / bpm) * beats; }

  function scheduleLoop(pattern, voices) {
    const T = Tone.Transport;
    T.bpm.value = pattern.tempo;
    const bpm = T.bpm.value;

    // anchor far enough in the future for Tone's clock to be ticking
    const loopStart = Math.max(Tone.now() + 0.5, 0.6);
    const swingShift = (pattern.swing - 0.5) * 0.18;     // up to 0.045 sec

    function at(barIdx, beat, sub = 0, swingAmt = 0) {
      // bar 0..7, beat 0..3 (quarter note), sub = 16th-note index within beat
      const offsetSec = beatsToSeconds(barIdx * 4 + beat + 0.25 * sub, bpm) + swingAmt;
      return loopStart + offsetSec;
    }

    // collect every event (time, voice, fn) and sort by time so no same-voice time collisions
    const events = [];
    const queue = (voice, time, note, dur, vel) =>
      events.push({ time, voice, note, dur, vel });

    for (let bar = 0; bar < 8; bar++) {
      const chord = pattern.progression[bar % pattern.progression.length];
      const notes = chordNotes(chord.root, chord.type, 4);
      const bassNotes = chordNotes(chord.root, chord.type === 'maj7' || chord.type === '9'
        ? 'maj7' : 'm7', 2);

      // pad (chord) at start of every bar
      queue('piano', at(bar, 0), notes, '1m', 0.5);
      queue('piano', at(bar, 0), notes.map(n => n * 2), '1m', 0.25);

      // arpeggio: swung off-beat 16ths over the chord
      for (let i = 0; i < 16; i++) {
        if (i % 2 === 1 && pattern.rng() < 0.7) {
          const t = at(bar, Math.floor(i / 4), i % 4);
          const n = notes[Math.floor(pattern.rng() * notes.length)];
          queue('piano', t, n, '16n', 0.4);
        }
      }

      // bass
      queue('bass', at(bar, 0), bassNotes[0], '4n', 0.8);
      queue('bass', at(bar, 2), bassNotes[1] || bassNotes[0], '8n', 0.6);

      // melody: sparse sax over chord tone
      if (voices.sax && pattern.includeSax) {
        if (pattern.rng() < 0.6) {
          const melodyNotes = chordNotes(chord.root, chord.type, 5);
          queue('sax', at(bar, 1), pick(pattern.rng, melodyNotes), '4n', 0.3);
        }
        if (pattern.rng() < 0.4) {
          const melodyNotes = chordNotes(chord.root, chord.type, 5);
          queue('sax', at(bar, 2), pick(pattern.rng, melodyNotes), '2n', 0.25);
        }
      }

      // drums
      const density = pattern.drumDensity;
      const hatEvery = density === 'sparse' ? 4 : 2;
      queue('kick', at(bar, 0), 'C2', '8n', 0.9);
      queue('kick', at(bar, 2), 'C2', '8n', 0.7);
      if (density === 'bouncy' && bar % 2 === 1) {
        queue('kick', at(bar, 0, 1), 'C2', '16n', 0.5);
      }
      if (bar % 2 === 1) {
        queue('snare', at(bar, 1), 'C2', '8n', 0.6);
      }
      for (let i = 0; i < 16; i += hatEvery) {
        const t = at(bar, Math.floor(i / 4), i % 4);
        // nudge hats apart by tiny increments on (sub) to avoid same-voice time equality
        const tJittered = t + (i % 4) * 0.001;
        const vel = (i % 4 === 0) ? 0.35 : 0.18;
        queue('hat', tJittered, null, '32n', vel);
      }
    }

    // sort by time, then dispatch
    events.sort((a, b) => a.time - b.time);
    let lastTime = { piano: -1, bass: -1, sax: -1, kick: -1, snare: -1, hat: -1 };
    for (const e of events) {
      // enforce strict monotonic time per voice
      if (e.time <= lastTime[e.voice] + 0.001) {
        e.time = lastTime[e.voice] + 0.005;
      }
      lastTime[e.voice] = e.time;
      let v;
      if (e.voice === 'piano') v = voices.piano;
      else if (e.voice === 'bass') v = voices.bass;
      else if (e.voice === 'sax') v = voices.sax.synth;
      else if (e.voice === 'kick') v = voices.drums.kick;
      else if (e.voice === 'snare') v = voices.drums.snare;
      else if (e.voice === 'hat') v = voices.drums.hat;
      if (e.note === null) {
        v.triggerAttackRelease(e.dur, e.time, e.vel);
      } else {
        v.triggerAttackRelease(e.note, e.dur, e.time, e.vel);
      }
    }

    const totalSec = beatsToSeconds(32, bpm);
    return { loopStart, totalSec };
  }

  function tickLoop(pattern, voices, mix) {
    const { totalSec } = scheduleLoop(pattern, voices);
    // re-arm a fresh loop ~3 seconds before this one ends so we never run out of audio
    return setTimeout(() => {
      if (voices && voices.piano) tickLoop(pattern, voices, mix);
    }, (totalSec - 3) * 1000);
  }

  // ---- the public engine ---------------------------------------------------
  class LofiEngine {
    constructor() {
      this.started = false;
      this.listeners = [];
      this.currentBucket = -1;
      this.pattern = null;
      this.voices = null;
      this.mixBus = null;
      this._loopId = null;
    }

    on(name, fn) {
      this.listeners.push({ name, fn });
    }
    _emit(name, data) {
      this.listeners.filter(l => l.name === name).forEach(l => l.fn(data));
    }

    async start() {
      if (this.started) return;
      this.started = true;
      await Tone.start(); // unlock audio context on user gesture

      // master mix bus with per-instrument gains
      this.mixBus = {
        piano: new Tone.Gain(1).toDestination(),
        sax:   new Tone.Gain(0).toDestination(),
        bass:  new Tone.Gain(1).toDestination(),
        drums: new Tone.Gain(1).toDestination(),
        vinyl: new Tone.Gain(0.4).toDestination(),
      };
      this.voices = {
        piano: buildPiano().connect(this.mixBus.piano),
        sax:   (() => { const s = buildSax(); s.output.connect(this.mixBus.sax); return s; })(),
        bass:  buildBass().connect(this.mixBus.bass),
        drums: (() => {
          const d = buildDrums();
          d.kick.disconnect(); d.snare.disconnect(); d.hat.disconnect();
          d.kick.connect(this.mixBus.drums);
          d.snare.connect(this.mixBus.drums);
          d.hat.connect(this.mixBus.drums);
          return d;
        })(),
        vinyl: (() => { const v = buildVinyl(); v.g.connect(this.mixBus.vinyl); return v; })(),
      };

      this._loopId = setInterval(() => {
        const b = Math.floor(Date.now() / BUCKET_MS);
        if (b !== this.currentBucket) this._crossfadeToBucket(b);
      }, 1000);

      // wait for the audio context to actually advance before scheduling anything
      await Tone.context.resume();
      // wait until Tone.now() is > 0 (tone.js needs a real elapsed time)
      if (Tone.now() < 0.05) await new Promise(r => setTimeout(r, 60));

      this._loadBucket(Math.floor(Date.now() / BUCKET_MS));

      this._emit('started', { pattern: this.pattern });
    }

    stop() {
      if (!this.started) return;
      Tone.Transport.stop();
      Tone.Transport.cancel(0);
      clearInterval(this._loopId);
      Object.values(this.voices).forEach(v => {
        if (v && typeof v.dispose === 'function') v.dispose();
        else if (v && v.synth) v.synth.dispose();
      });
      if (this._loopTimer) clearTimeout(this._loopTimer);
      Object.values(this.mixBus).forEach(g => g.dispose());
      this.started = false;
      this.currentBucket = -1;
      this.pattern = null;
      this._loopTimer = null;
    }

    setMix(name, value) {
      if (!this.mixBus || !this.mixBus[name]) return;
      // smooth ramp to avoid clicks
      this.mixBus[name].gain.rampTo(value, 0.2);
    }

    _loadBucket(bucket) {
      this.currentBucket = bucket;
      this.pattern = generatePattern(bucket);
      // set initial sax level depending on whether sax is in this pattern
      if (this.voices && this.mixBus) {
        this.mixBus.sax.gain.rampTo(this.pattern.includeSax ? 0.7 : 0, 0.5);
      }
      this._loopTimer = tickLoop(this.pattern, this.voices, this.mixBus);
      this._emit('bucket', this.pattern);
    }

    _crossfadeToBucket(newBucket) {
      // For MVP: a hard cut on bucket boundaries is fine since patterns
      // share BPM-randomization ranges and start on bar 0. (Future: dual-engine crossfade.)
      Tone.Transport.cancel(0);
      this._loadBucket(newBucket);
    }
  }

  window.LofiEngine = LofiEngine;
  window.LOFI_BUCKET_MS = BUCKET_MS;
})();
