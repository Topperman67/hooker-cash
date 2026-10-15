# Quant Pad launch ad

A 30 s, 1080p30 commercial built in code: Remotion + React Three Fiber for the 3D, and a
synthesized soundtrack (music bed and all sound effects) mixed to −14 LUFS. The brief is in
[PROMPT.md](PROMPT.md).

```bash
npm ci
npm run studio   # live preview at http://localhost:3000
npm run review   # stills from each shot → out/sheet.png
npm run render   # soundtrack + out/quantpad-ad-30s.mp4 + out/poster.png
```

- `src/timeline.js` holds every timing: shots, hook beats, sound cues, supers and the end-card
  `URL`. Picture and sound both read it.
- `src/scene/`: the 3D. The logo is extruded from `public/brand/*.svg` (`npm run logo` refreshes
  `logo-data.js` after a brand change).
- `src/overlays/`: supers, hook chips, the holographic card, titles and the end card.
- `scripts/make-audio.mjs`: the soundtrack. Put a licensed track at `public/music.wav` to replace
  the synthesized bed; the sound effects stay.
- Renders use the headless Chromium from Playwright if it is installed (`REMOTION_BROWSER`
  overrides it), with GPU WebGL through ANGLE.

## The flywheel film

A 30 s, 1080p30 film of the fee flywheel from the home page, as one continuous take through a
working machine (`src/flywheel/`). Trades race round the glass chart; the gate slices 7% off every
one and the slivers fill the well; the well pours onto the chart and the light splits 60% green,
40% pink; holders are paid by a snapshot; the buyback & burn line buys coins off the supply and
burns them; then the buyback & burn arrows circle the flywheel under the end card.

```bash
npm run flywheel:stills -- 150 330 860   # review frames → out/flywheel/stills/
npm run flywheel                         # soundtrack + out/flywheel/quantpad-flywheel.mp4 + poster.png
```

- `src/flywheel/timeline.js` holds the fee numbers (`FEE`, `SPLIT`), the copy and every cue.
  Picture and sound both read it; `layout.js` holds where things sit and the paths they travel.
- `scripts/flywheel-audio.mjs` writes the soundtrack from the same timeline and layout. The gate's
  slices play the arpeggio, the dial ticks as its hand passes each mark, and so on. Both
  soundtracks share the synth kit in `scripts/instruments.mjs`.
- Without a GPU (a CI box or cloud container), render on the CPU with `REMOTION_GL=swangle`
  (about 7 s a frame at `CONCURRENCY=3` on 4 cores).
