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
- `public/meteora-mark.png` is cut from the Meteora badge with
  `node scripts/key-meteora.mjs <badge.png>`.
- `scripts/make-audio.mjs`: the soundtrack. Put a licensed track at `public/music.wav` to replace
  the synthesized bed; the sound effects stay.
- Renders use the headless Chromium from Playwright if it is installed (`REMOTION_BROWSER`
  overrides it), with GPU WebGL through ANGLE.

## Payout engine film

A 38 s, 1080p30 explainer of the $QUANTP payout engine (composition `PayoutEngine`,
`src/engine/`), with its own synthesized soundtrack.

```bash
npm run engine:render                     # soundtrack + out/quantp-payout-engine.mp4 + poster
node scripts/render-engine.mjs 45 360 870 # review stills → out/engine/f45.png …
npm test                                  # the timeline checks (tests/engine-timeline.test.mjs)
```

- `src/engine/timeline.js` holds every timing and every fact the film states. The picture and
  `scripts/make-engine-audio.mjs` both read its schedules, so each sound lands on its picture
  event. The film and its soundtrack refuse to build if the engine's rules in
  `shared/network.mjs` (the split, the fee, the minimum hold, hourly runs, the tiers) no longer
  match what the film says (`assertRules`); the ad and the stills, in the same bundle, still build.
- `src/engine/holders.js` is a hand-taken mainnet snapshot of the holders (no addresses). The
  holders scene pays the snapshot by the engine's own rule (`planRun` in
  `server/quantp-engine.mjs`) from a stated pot.
- The burn and the site scene's figures are dated in `FACTS`: refresh them from
  `/api/quantp/ledger` and `/api/quantp/engine` before a new render.
- The full render always rebuilds the soundtrack first (`npm run engine:audio` builds it alone).
  The film states the team funds the wallet and is not financial advice; it is a marketing asset,
  so post it only once it has been approved.
