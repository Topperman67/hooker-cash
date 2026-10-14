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
