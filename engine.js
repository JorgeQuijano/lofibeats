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
  function tickLoop(pattern, voices, mix, onCrossfade) {
    // schedule one full 8-bar loop; Tone.Transport handles timing
    const T = Tone.Transport;
    T.bpm.value = pattern.tempo;
    const swing = pattern.swing;
    const step = 0.25;                     // 16th note
    const swingOffset = step * (swing - 0.5) * 2; // shift the off-beat 16ths

    // 8 bars, 16 steps each = 128 steps
    for (let bar = 0; bar < 8; bar++) {
      const chord = pattern.progression[bar % pattern.progression.length];
      const notes = chordNotes(chord.root, chord.type, 4);
      const bassNotes = chordNotes(chord.root, chord.type === 'maj7' || chord.type === '9'
        ? 'maj7' : 'm7', 2);

      // pad: chord pad at start of every bar (piano-ish)
      const padTime = `${bar}:0:0`;
      voices.piano.triggerAttackRelease(notes, "1m", padTime);

      // arpeggio: swung off-beat 16ths over the chord
      for (let i = 0; i < 16; i++) {
        if (i % 2 === 1 && pattern.rng() < 0.7) {
          const t = `${bar}:0:${i}`;
          const n = notes[Math.floor(pattern.rng() * notes.length)];
          voices.piano.triggerAttackRelease(n, "16n", t, 0.4);
        }
      }

      // bass: root + 5th on beat 1 and 3 with ghost notes
      const bassRoot = bassNotes[0];
      const bassFifth = bassNotes[1] || bassNotes[0];
      voices.bass.triggerAttackRelease(bassRoot, "4n", `${bar}:0:0`, 0.8);
      voices.bass.triggerAttackRelease(bassFifth, "8n", `${bar}:0:2`, 0.6);

      // melody: sparse sax-ish voice wandering over the chord
      if (voices.sax && pattern.includeSax && pattern.rng() < 0.6) {
        const melodyNotes = chordNotes(chord.root, chord.type, 5);
        const pick1 = melodyNotes[Math.floor(pattern.rng() * melodyNotes.length)];
        const pick2 = melodyNotes[Math.floor(pattern.rng() * melodyNotes.length)];
        voices.sax.synth.triggerAttackRelease(pick1, "4n", `${bar}:1:0`, 0.35);
        if (pattern.rng() < 0.7) {
          voices.sax.synth.triggerAttackRelease(pick2, "2n", `${bar}:2:0`, 0.3);
        }
      }

      // drums
      const density = pattern.drumDensity;
      const hatEvery = density === 'sparse' ? 4 : 2;
      voices.drums.kick.triggerAttackRelease("C2", "8n", `${bar}:0:0`, 0.9);
      voices.drums.kick.triggerAttackRelease("C2", "8n", `${bar}:0:2`, 0.7);
      if (density === 'bouncy' && bar % 2 === 1) {
        voices.drums.kick.triggerAttackRelease("C2", "16n", `${bar}:0:1`, 0.5);
      }
      if (bar % 2 === 1) {
        voices.drums.snare.triggerAttackRelease("8n", `${bar}:1:0`, 0.6);
      }
      for (let i = 0; i < 16; i += hatEvery) {
        const t = `${bar}:0:${i}`;
        const vel = (i % 4 === 0) ? 0.4 : 0.2;
        voices.drums.hat.triggerAttackRelease("32n", t, vel);
      }
    }
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

      this._loadBucket(Math.floor(Date.now() / BUCKET_MS));
      Tone.Transport.start();

      this._loopId = setInterval(() => {
        const b = Math.floor(Date.now() / BUCKET_MS);
        if (b !== this.currentBucket) this._crossfadeToBucket(b);
      }, 1000);

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
      Object.values(this.mixBus).forEach(g => g.dispose());
      this.started = false;
      this.currentBucket = -1;
      this.pattern = null;
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
      tickLoop(this.pattern, this.voices, this.mixBus);
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
