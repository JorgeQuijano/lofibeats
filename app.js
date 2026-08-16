// app.js — wires the engine to the DOM
(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const playBtn   = $('#play');
  const statusEl  = $('#status');
  const dotEl     = $('#dot');
  const seedEl    = $('#seed-label');
  const nextEl    = $('#next-label');
  const mixInputs = document.querySelectorAll('input[data-instrument]');

  const engine = new LofiEngine();
  let countdownTimer = null;

  function updateCountdown() {
    const msLeft = window.LOFI_BUCKET_MS - (Date.now() % window.LOFI_BUCKET_MS);
    const sec = Math.ceil(msLeft / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    nextEl.textContent = `next beat switch in ${mm}:${ss}`;
  }

  function setLive(live) {
    if (live) {
      statusEl.textContent = 'on air';
      dotEl.classList.add('live');
    } else {
      statusEl.textContent = 'off';
      dotEl.classList.remove('live');
    }
  }

  function setPlayLabel(label) { playBtn.querySelector('.play-label').textContent = label; }

  playBtn.addEventListener('click', async () => {
    playBtn.disabled = true;
    setPlayLabel('warming up…');
    try {
      await engine.start();
      setPlayLabel('on air — keep this tab open');
      setLive(true);
      updateCountdown();
      countdownTimer = setInterval(updateCountdown, 1000);
    } catch (err) {
      console.error(err);
      setPlayLabel('tap to start');
      playBtn.disabled = false;
    }
  });

  // mix sliders: live updates while playing
  mixInputs.forEach(input => {
    input.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      engine.setMix(e.target.dataset.instrument, v);
    });
  });

  engine.on('bucket', (pattern) => {
    // round-trip the pattern's truth back into the UI knobs for sax
    const saxInput = document.querySelector('input[data-instrument="sax"]');
    if (saxInput && pattern.includeSax) {
      saxInput.value = saxInput.value === '0' ? 0.7 : saxInput.value;
    }
    seedEl.textContent = `seed ${pattern.seed} · ${pattern.rootKey} ${pattern.scale} · ${pattern.tempo} bpm`;
  });
})();
