# Quant Pad launch ad: production brief

**Role.** You are the motion designer and sound designer for Quant Pad's first ad. Build it in code and render a finished MP4.

**Objective.** A 30-second, 16:9 commercial that makes a crypto-native viewer understand one thing in one watch: Quant Pad launches your coin on pump.fun and splits its creator fees into four on-chain Quantum Hooks. It should look like a premium 3D product film (the polish of a hardware launch film) and hit hard on sound.

**Deliverables.** `quantpad-ad-30s.mp4`: 1920×1080, 30 fps, 900 frames, H.264 High, yuv420p, CRF 16, AAC 48 kHz stereo at 320 kbps. Loudness −14 LUFS integrated, true peak ≤ −1 dBTP. Also a poster-frame PNG and a contact sheet with one frame per shot.

**Brand rules (non-negotiable)**
- Concept "Refractor": creator fees enter as white light and leave the Q as four coloured lines, one per hook. The lines are always crisp and separate. Never blend them into a rainbow.
- Colour: pearl `#E9ECF0`, plate `#FAFBFC`, ink `#15181D`, graphite `#262B34`. Cobalt `#2E4BFF` is Creator share, pink `#FF3EA5` Quantum Burn, green `#12C26E` Entanglement and yellow `#FFC21A` Fusion. The only saturated colour in frame comes from those four lines.
- Logo: a true 3D extrusion of the Q from `public/brand/mark.svg`. The body is a heavy squircle Q in polished silver chrome. The tail is a separate cobalt-anodised slab, cut off by a hairline gap. Never redraw or approximate the logo. The QUANT PAD wordmark comes from the lockup SVG.
- Type: Hubot Sans, wide (`wdth` 110–125), for headlines. Mona Sans for body text, Martian Mono for numbers. Sentence case. The wordmark is the only all-caps element.
- Materials: polished chrome, cobalt-anodised metal, graphite instrument panels, and a pearl photo studio with softbox reflections. Four light lines rake across the chrome at 45°.

**Look**
- Real-time PBR 3D. Chrome lit by a studio softbox environment that includes four coloured strip lights; their reflections are the brand lines.
- Effects: bloom on the light lines only, shallow depth of field, light film grain and vignette. Chromatic aberration only on impacts. Motion blur on fast moves.
- Camera: motivated moves only (slow push-ins, orbit reveals, one fly-through), all eased. No linear moves and no shake, except a 2-frame jolt on the two big impacts.
- Pacing: 120 BPM, so one beat is 15 frames. Every cut and impact lands on the beat grid.

**Shot list** (timings in seconds)
1. **0.0–4.0 Ignition.** Near-black graphite studio with haze. A thin white beam draws itself diagonally from top-left, volumetric, with dust motes catching it. Slow push. Super at 1.5 s in Hubot Sans, steel: "Every trade pays a creator fee."
2. **4.0–8.0 The Q.** On the 4.0 downbeat the beam strikes the chrome Q and reveals it. Studio lights snap on and the backdrop lifts from graphite to pearl. The camera arcs about 40° from three-quarter view to front. At 5.5 a glint sweeps the bevel. No text; let the logo breathe.
3. **8.0–14.0 Refraction.** The beam enters the Q's counter and four lines fire out of the tail, one every 1.5 s. The camera tracks each line to its payoff, with a label chip of the hook name and its one-line description:
   - 8.0 **Creator share** (blue): a SOL coin flips into a wallet slot. "Paid to you every pulse."
   - 9.5 **Quantum Burn** (pink): the line buys a coin token, which ignites and breaks apart into pink embers. "Buys the coin and burns it."
   - 11.0 **Entanglement** (green): the line splits into dozens of fine filaments that light up a constellation of holder nodes. "Shares SOL with holders."
   - 12.5 **Fusion** (yellow): light pours into a glass liquidity vault, which seals with a lock ring. "Adds locked liquidity."
4. **14.0–20.0 The pulse.** Pull back to a wide hero of the whole Refractor. On every bar a white pulse travels the beam and splits into the four lines. A graphite holographic launch card (chrome-framed art, silver ticker, hook loadout as four coloured bars at 30/30/20/20, captioned "Example split") rises into the foreground and tilts, with light lines sliding across its foil. Super: "Rules locked at launch. Enforced on-chain."
5. **20.0–25.0 Headline run.** Fast, beat-cut kinetic type over a fly-through of the Q's counter, like a chrome tunnel. "Launch on pump.fun." at 20.0, "Route every fee through" at 21.5, then "Quantum Hooks." at 23.0 in chrome lettering with the four lines sweeping across it, held to 25.0.
6. **25.0–30.0 End card.** At 25.0, half a beat of hard silence. At 25.5 the 3D Q drops into place with a heavy impact, the four lines rake across it at 45°, and the QUANT PAD wordmark resolves beside it. A cobalt CTA reads "Launch a coin", with the URL below it. Fine print in Mona Sans, steel: "Memecoins are extremely risky. Only use SOL you can afford to lose." The frame holds clean for the last 2 s.

**Sound design** (all original and synthesized; no stock or downloaded audio)
- **Music bed:** 120 BPM, dark and minimal electronic: sub bass, tight kick, clap on 2 and 4, crisp hats, detuned pad chords, and a glassy pluck arpeggio that plays the four hook notes. The bed starts sparse, reaches the full groove at 8.0, breaks down into a riser from 20 to 25, drops to silence at 25.0 and ends on the final hit.
- **Cue sheet**
  - 0.0: sub drone swell, plus an airy reverse-cymbal riser
  - 0.6: beam ignition, a rising sine sweep with a filtered-noise "fwoom" and a faint electrical crackle
  - 4.0: reveal impact, a pitch-dropping sub boom layered with a metallic hit and a long, wide shimmer tail
  - 5.5: glint "ting" (high bell partials)
  - 8.0, 9.5, 11.0, 12.5: four laser zaps tuned to an ascending A–C♯–E–A arpeggio, panned left to right with each line. Each has its own layer: a coin-flip clink (blue), a fire whoosh and crumble (pink), a cascade of sparkle chimes (green), and a heavy lock clunk with glass resonance (yellow).
  - 14.0: bass drop into the groove, with a soft "whomp" on every pulse
  - 16.0: card-rise whoosh and holographic shimmer
  - 20.0, 21.5, 23.0: a whoosh-hit on each title, with a reverse reverb into 23.0
  - 23.0–25.0: riser and snare roll
  - 25.0: half a beat of hard silence
  - 25.5: final impact (sub drop, chrome hit and the four-note hook chime) with a reverb tail to 30.0
- **Mix:** the bed sits about 6 dB under the SFX, and impacts duck it by sidechain. A master limiter holds the targets above.

**Guardrails**
- Use only the app's own claims. No price talk, "guaranteed", "passive income", "safe" or "100x".
- Label split percentages as an example.
- No third-party logos. pump.fun appears as text only.
- Every super stays on screen for at least 1.5 s, inside a 5% safe margin.

**Acceptance checklist**
- The logo matches `mark.svg`, with a cobalt tail and a visible gap. No rainbow blends anywhere.
- Cuts and impacts sit on the beat grid, and SFX sync within 1 frame.
- No flicker or crawling aliasing on chrome edges.
- The render is deterministic: the same frame always gives the same pixels.
- Loudness and peak meet the targets, with no clipping.

**End-card URL:** none yet. Set `URL` in `src/timeline.js`.
