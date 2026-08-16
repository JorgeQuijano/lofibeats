# lofibeats

infinite random lo-fi radio that synthesizes in the browser. every listener landing in the same 3-minute window hears the same "station" thanks to a time-bucketed seed.

## what's here

- `index.html` — single-page UI (mobile-first, dark, gradient pills)
- `style.css` — responsive layout + range slider styling
- `engine.js` — tone.js lo-fi engine: chord generator, swung drums, fm-piano, sax, bass, vinyl crackle
- `app.js` — wires engine to DOM, handles "tap to start" audio unlock, sliders, live countdown

## end state (eventually)

- per-instrument sliders (piano, sax, bass, drums, vinyl crackle) so users dial their own mix
- server broadcast for true "everyone hears the same byte-for-byte" when it matters
- taste / drizzle / mood UI (later)

## dev

```bash
# serve locally
python3 -m http.server 8080
# open http://localhost:8080
```

first click triggers `Tone.start()` — required by browsers before any audio plays.

## deploy

github pages, branch `gh-pages`. see commit history.
