// lofibeats engine — synthesizes lo-fi in the browser, seeded by 3-min time buckets
// Idiomatic Tone.js approach: events stored in seconds relative to a loop anchor,
// quantized to the loop length using Tone.Part's built-in memory.
(() => {
  'use strict';

  const BUCKET_MS = 3 * 60 * 1000;
  // Each "song" lasts BUCKET_MS / 1000 seconds; we play a longer loop and let the
  // 3-min timer crossfade the next variation.
  const LOOP_SECONDS = 16;          // one full 8-bar loop is ~16-22s at our tempos

  // ---- seeded RNG ---------------------------------------------------------
  function seedFromBucket(bucket) {
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

  // ---- music theory ------------------------------------------------------
  const ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const CHORD_TYPES = ['maj7', 'm7', 'm9', '9', '7sus4'];
  const PROGRESSIONS = [
    ['Imaj7', 'vi7', 'ii7', 'V7'],
    ['i7', 'iv7', 'VII7', 'III7'],
    ['Imaj7', 'IVmaj7', 'iii7', 'vi7'],
    ['ii7', 'V7', 'Imaj7', 'Imaj7'],
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
      maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14],
      '9': [0, 4, 7, 10, 14], '7sus4': [0, 5, 7, 10], '7': [0, 4, 7, 10],
      '7alt': [0, 4, 10, 13], IVmaj7: [0, 5, 7, 11], VIsus: [0, 7, 10, 16],
    }[type] || [0, 4, 7, 11];
    return intervals.map(i => Tone.Frequency(r + i, 'midi').toFrequency());
  }
  function romanToChord(roman, keyRoot) {
    const k = ROOT_NAMES.indexOf(keyRoot);
    const offsets = { I: 0, i: 0, ii: 2, ii: 2, iii: 4, III: 4, IV: 5, iv: 5, V: 7, v: 7, VI: 9, vi: 9, VII: 11, vii: 11 };
    const isMinor = roman === roman.toLowerCase();
    const base = roman.match(/^[ivxIVX]+/)[0].toLowerCase();
    const degree = offsets[base];
    const root = ROOT_NAMES[(k + degree) % 12];
    let type;
    if (base === 'v' && !isMinor) type = '7';
    else if (base === 'vii' && isMinor) type = '7alt';
    else if (base === 'iv' && !isMinor && roman.includes('maj')) type = 'IVmaj7';
    else if (base === 'vi' && roman.includes('sus')) type = 'VIsus';
    else if (isMinor) type = roman.includes('9') ? 'm9' : 'm7';
    else type = roman.endsWith('maj7') ? 'maj7' : (roman.includes('9') ? '9' : 'maj7');
    return { root, type };
  }

  function whiteNoiseBuffer(seconds = 2) {
    const buf = Tone.context.createBuffer(1, seconds * Tone.context.sampleRate, Tone.context.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1);
    return buf;
  }

  // ---- voices -------------------------------------------------------------
  function buildPiano() {
    return new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 1.0, modulationIndex: 2,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.4, sustain: 0.2, release: 1.6 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.01, decay: 0.3, sustain: 0, release: 0.4 },
    });
  }
  function buildSax() {
    const synth = new Tone.Synth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.04, decay: 0.2, sustain: 0.4, release: 0.6 },
    });
    const filter = new Tone.Filter(900, 'lowpass');
    const lfo = new Tone.LFO('4Hz', 800, 1500);
    lfo.connect(filter.frequency);
    lfo.start();
    synth.connect(filter);
    return { synth, output: filter };
  }
  function buildBass() {
    return new Tone.MonoSynth({
      oscillator: { type: 'triangle' },
      filter: { type: 'lowpass', frequency: 600, Q: 4 },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3, baseFrequency: 200, octaves: 2.5 },
    });
  }
  function buildDrums() {
    const kick = new Tone.MembraneSynth({
      pitchDecay: 0.04, octaves: 6,
      envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.4 },
    });
    const snare = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.18, sustain: 0 },
      filterEnvelope: { attack: 0.001, decay: 0.1, sustain: 0, baseFrequency: 1500, octaves: 2 },
    });
    const hat = new Tone.MetalSynth({
      frequency: 8000,
      envelope: { attack: 0.001, decay: 0.06, release: 0.05 },
      harmonicity: 5.1,
      modulationIndex: 2,
      resonance: 4000,
      octaves: 1.5,
    });
    return { kick, snare, hat };
  }
  function buildVinyl() {
    const src = new Tone.BufferSource(whiteNoiseBuffer(4));
    src.loop = true;
    src.start();
    const bp = new Tone.Filter(2000, 'bandpass');
    const g = new Tone.Gain(0.0);
    src.connect(bp); bp.connect(g);
    return { src, g };
  }

  // ---- pattern generation ------------------------------------------------
  function generatePattern(bucket) {
    const rng = mulberry32(seedFromBucket(bucket));
    const rootKey = pick(rng, ROOT_NAMES);
    const scale = pick(rng, ['major', 'minor']);
    const progression = pick(rng, PROGRESSIONS).map(r => {
      const minorRoot = scale === 'minor' ? r.toLowerCase() : r;
      return romanToChord(minorRoot, rootKey);
    });
    const swing = 0.55 + rng() * 0.10;
    const tempo = Math.round(70 + rng() * 18);
    const drumDensity = pick(rng, ['sparse', 'normal', 'bouncy']);
    return {
      seed: bucket, rng, rootKey, scale, progression, swing, tempo, drumDensity,
      includeSax: rng() < 0.45,
    };
  }

  // ---- sequence: build a list of {time, fn} events in seconds ------------
  function buildEvents(pattern) {
    const events = [];
    const tempi = 60 / pattern.tempo;
    const beatSec = tempi;                      // quarter note duration in seconds
    const barSec = beatSec * 4;
    const swingOff = (pattern.swing - 0.5) * beatSec * 0.25;  // tiny swing on off-beats

    for (let bar = 0; bar < 8; bar++) {
      const tBar = bar * barSec;
      const chord = pattern.progression[bar % pattern.progression.length];
      const notes = chordNotes(chord.root, chord.type, 4);
      const bassNotes = chordNotes(chord.root,
        chord.type === 'maj7' || chord.type === '9' ? 'maj7' : 'm7', 2);

      // piano pad on the downbeat of every bar (long chord)
      events.push({ t: tBar, v: 'pad', notes, dur: barSec * 0.95 });

      // arpeggio: off-beat 16th notes over the chord
      for (let i = 1; i < 8; i += 2) {
        if (pattern.rng() < 0.75) {
          const t = tBar + i * (beatSec / 2) + swingOff;
          const n = pick(pattern.rng, notes);
          events.push({ t, v: 'piano', notes: [n], dur: beatSec / 4 });
        }
      }
      // piano on strong offbeats in upper register
      if (pattern.rng() < 0.6) {
        const t = tBar + 2 * beatSec + swingOff * 0.5;
        const n = pick(pattern.rng, notes) * 2;
        events.push({ t, v: 'piano', notes: [n], dur: beatSec / 2 });
      }

      // bass: root, fifth
      events.push({ t: tBar, v: 'bass', notes: [bassNotes[0]], dur: beatSec * 0.9 });
      events.push({ t: tBar + 2 * beatSec, v: 'bass', notes: [bassNotes[1] || bassNotes[0]], dur: beatSec * 0.5 });

      // sax melody — sparse, occasional
      if (pattern.includeSax) {
        const mel = chordNotes(chord.root, chord.type, 5);
        if (pattern.rng() < 0.5) {
          events.push({ t: tBar + beatSec, v: 'sax', notes: [pick(pattern.rng, mel)], dur: beatSec * 0.5 });
        }
        if (pattern.rng() < 0.4) {
          events.push({ t: tBar + 2 * beatSec + beatSec * 0.5, v: 'sax', notes: [pick(pattern.rng, mel)], dur: beatSec * 0.8 });
        }
      }

      // drums
      events.push({ t: tBar,           v: 'kick',  notes: ['C2'], dur: beatSec / 2 });
      events.push({ t: tBar + 2 * beatSec, v: 'kick', notes: ['C2'], dur: beatSec / 2 });
      if (pattern.drumDensity === 'bouncy' && bar % 2 === 1) {
        events.push({ t: tBar + beatSec / 2 + swingOff, v: 'kick', notes: ['C2'], dur: beatSec / 4 });
      }
      if (bar % 2 === 1) {
        events.push({ t: tBar + beatSec, v: 'snare', notes: null, dur: beatSec / 2 });
      }
      const hatEvery = pattern.drumDensity === 'sparse' ? 2 : 1;
      for (let i = 0; i < 8; i += hatEvery) {
        const t = tBar + i * (beatSec / 2) + (i % 2 ? swingOff : 0);
        events.push({ t, v: 'hat', notes: null, dur: beatSec / 8, vel: i % 4 === 0 ? 0.4 : 0.2 });
      }
    }
    return { events, loopSec: 8 * barSec };
  }

  // ---- the public engine ------------------------------------------------
  class LofiEngine {
    constructor() {
      this.started = false;
      this.listeners = [];
      this.currentBucket = -1;
      this.pattern = null;
      this.voices = null;
      this.mixBus = null;
      this._loopTimer = null;
      this._bucketTimer = null;
    }

    on(name, fn) { this.listeners.push({ name, fn }); }
    _emit(name, data) { this.listeners.filter(l => l.name === name).forEach(l => l.fn(data)); }

    async start() {
      if (this.started) return;
      this.started = true;

      // iOS / Safari needs a real user gesture to unlock audio
      await Tone.start();
      // ensure AudioContext is running and lookAhead is sane
      await Tone.context.resume();

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
          d.kick.connect(this.mixBus.drums);
          d.snare.connect(this.mixBus.drums);
          d.hat.connect(this.mixBus.drums);
          return d;
        })(),
        vinyl: (() => { const v = buildVinyl(); v.g.connect(this.mixBus.vinyl); return v; })(),
      };

      this._bucketTimer = setInterval(() => {
        const b = Math.floor(Date.now() / BUCKET_MS);
        if (b !== this.currentBucket) this._loadBucket(b);
      }, 1000);

      this._loadBucket(Math.floor(Date.now() / BUCKET_MS));

      // small delay to let the audio context settle, then play
      setTimeout(() => this._emit('started', { pattern: this.pattern }), 100);
    }

    setMix(name, value) {
      if (!this.mixBus || !this.mixBus[name]) return;
      this.mixBus[name].gain.rampTo(value, 0.2);
    }

    _loadBucket(bucket) {
      this.currentBucket = bucket;
      this.pattern = generatePattern(bucket);
      const { events, loopSec } = buildEvents(this.pattern);

      // re-arm sax level depending on pattern
      this.mixBus.sax.gain.rampTo(this.pattern.includeSax ? 0.7 : 0, 0.5);

      // schedule each event individually with a small per-event look-ahead ahead
      // of the current Tone.now() so the dispatcher's monotonicity check never trips.
      const baseDelay = 0.1;
      const realNow = Tone.now() + baseDelay;

      // group same-voice events sorted ascending, dispatch with min spacing
      events.sort((a, b) => a.t - b.t);
      const lastTime = { piano: -1, bass: -1, sax: -1, kick: -1, snare: -1, hat: -1 };
      const perVoiceMinGap = 0.012; // 12ms — Tone's inter-trigger minimum

      for (const e of events) {
        const desired = realNow + e.t;
        const minAllowed = Math.max(realNow, lastTime[e.v] + perVoiceMinGap);
        const finalTime = Math.max(desired, minAllowed);
        lastTime[e.v] = finalTime;
        this._dispatch(e, finalTime);
      }

      // schedule next iteration 1 sec before this one ends so we never gap
      if (this._loopTimer) clearTimeout(this._loopTimer);
      this._loopTimer = setTimeout(() => this._loadBucket(this.currentBucket), (loopSec - 1) * 1000);

      this._emit('bucket', this.pattern);
    }

    _dispatch(e, time) {
      try {
        const v = this.voices;
        const vel = e.vel != null ? e.vel : 0.7;
        if (e.v === 'pad')   v.piano.triggerAttackRelease(e.notes, e.dur, time, 0.5);
        else if (e.v === 'piano') v.piano.triggerAttackRelease(e.notes[0], e.dur, time, 0.4);
        else if (e.v === 'bass')  v.bass.triggerAttackRelease(e.notes[0], e.dur, time, 0.8);
        else if (e.v === 'sax')   v.sax.synth.triggerAttackRelease(e.notes[0], e.dur, time, 0.3);
        else if (e.v === 'kick')  v.drums.kick.triggerAttackRelease('C2', e.dur, time, vel);
        else if (e.v === 'snare') v.drums.snare.triggerAttackRelease(e.dur, time, vel);
        else if (e.v === 'hat')   v.drums.hat.triggerAttackRelease(e.dur, time, vel);
      } catch (err) {
        // swallow — we don't want one bad event to halt the whole engine
        // but log once for debugging
        if (!this._erroredOnce) { this._erroredOnce = true; console.warn('dispatch skipped:', err.message, 'event=', e.v); }
      }
    }
  }

  window.LofiEngine = LofiEngine;
  window.LOFI_BUCKET_MS = BUCKET_MS;
})();
