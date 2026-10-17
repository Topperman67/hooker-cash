# Quant Pad design: "Refractor"

**Concept.** Quant Pad works like a prism. A coin's pump.fun creator fees enter as white light and
leave as coloured lines, one per Quantum Hook. The identity is polished chrome in a pearl photo
studio. The only colour comes from four light lines (blue, pink, green and yellow), and they are
always crisp separate lines, never a rainbow blend.

## Logo

- **Mark ("Q-Pad").** A heavy squircle Q in silver chrome. Its tail is a separate cobalt-anodised slab, cut off by a hairline gap: the slab is where fees leave the coin. Four light lines rake across the metal at 45°.
- **Files** in `public/brand/`:

  | File               | Use                                                          |
  | ------------------ | ------------------------------------------------------------ |
  | `mark.svg`         | Silver chrome                                                |
  | `mark-black.svg`   | Black chrome                                                 |
  | `mark-small*.svg`  | Favicon cut (no filters, heavier geometry, light/dark aware) |
  | `mark-mono*.svg`   | Single flat colour                                           |
  | `lockup-light.svg` | Black chrome, on pearl                                       |
  | `lockup-dark.svg`  | Silver chrome, on graphite                                   |
  | `lockup-mono.svg`  | Under ~36 px tall                                            |

- **Wordmark.** The QUANT PAD wordmark is custom drawn (wide racing letters from rounded rectangles and 45° slabs) and needs no font.
- **Source.** The generator lives outside the repo (`build.mjs` from the brand exploration). To change the four line colours, edit its `diffraction` stops and rebuild.

## Colour

| Role                                              | Token                       | Value                 |
| ------------------------------------------------- | --------------------------- | --------------------- |
| Page (pearl studio)                               | `--pearl`                   | `#E9ECF0`             |
| Plates (raised surfaces)                          | `--plate`                   | `#FAFBFC`             |
| Rules, borders                                    | `--mercury` / `--mercury-2` | `#BCC3CD` / `#D5DAE1` |
| Secondary text                                    | `--steel`                   | `#5F6876`             |
| Text, black chrome base                           | `--ink`                     | `#15181D`             |
| Instrument panels (chart, ticket, trades, footer) | `--graphite`                | `#262B34`             |
| Brand, primary buttons, Creator share             | `--blue`                    | `#2E4BFF`             |
| Quantum Burn, sell                                | `--pink`                    | `#FF3EA5`             |
| Entanglement, buy                                 | `--green`                   | `#12C26E`             |
| Fusion                                            | `--yellow`                  | `#FFC21A`             |
| Superposition                                     | `--blue-tint`               | `#8FA4FF`             |
| Time Dilation                                     | `--yellow-tint`             | `#FFE08A`             |

- On pearl, buy and sell use deeper shades (`--buy` `#0A8F50`, `--sell` `#D81F78`) for contrast.
- On graphite they use full brightness (`--buy-bright`, `--sell-bright`).
- Yellow is never used for text on pearl. It appears as lines, dots and fills next to ink labels.

### Night studio (dark theme)

The same studio with the lights down. Light is the default, even when the OS prefers dark. The
round glass switch in the header (sun to moon) stores the choice, and `public/theme-init.js`
applies it before first paint as `<html data-theme>`. Every night rule lives in
`src/styles/theme-dark.css`, scoped to `:root[data-theme='dark']`, so light never changes by
accident.

| Role                    | Token               | Night value           |
| ----------------------- | ------------------- | --------------------- |
| Page                    | `--pearl`           | `#07080C`             |
| Plates                  | `--plate`           | `#12151B`             |
| Text / secondary text   | `--ink` / `--steel` | `#F1F4F8` / `#BCC4CF` |
| Instruments             | `--graphite`        | `#191D25`             |
| Buy / sell              | `--buy` / `--sell`  | `#18D47A` / `#FF92CE` |
| Focus ring              | `--focus`           | `#8FA4FF`             |
| Lettering, step numbers | `--night-chrome`    | silver chrome         |

- The four colour pools stay and are dimmer. The 45° lines glow, but fade out before the reading column.
- Panels become smoked glass with a lit top-left rim. The header and hero lenses turn dark in the same render as the switch.
- The lockup swaps to `lockup-dark.svg`. The flywheel card stays cobalt, with a faint rim.
- Muted text keeps 4.5:1 on the page and on smoked glass under the brightest pool (`tests/unit/theme.test.mjs`).

## Materials

- **Chrome.** `--chrome`, `--black-chrome` and `--silver-chrome` gradients for the mark, the "Quantum Hooks." headline, avatars and step numerals.
- **Light lines.** `--lines` (buttons, chips) and `--lines-thin` (large lettering, holo cards). The pointer is the studio light: `useGlobalGlint` slides the lines across chrome text as the cursor moves. Holo cards tilt and track the lines under the pointer. Both are off under reduced motion.
- **Surfaces.**
  - Plates are near-white with a white top edge and a soft studio shadow.
  - Graphite instruments hold anything you trade with.
  - Primary buttons are cobalt-anodised metal with a four-line sheen on hover.

## Type

- **Hubot Sans** (variable width): display. Headlines run at `wdth` 110–118. "Quantum Hooks." and coin tickers run at 125.
- **Mona Sans:** interface and body text.
- **Martian Mono:** prices, SOL amounts, tickers and percentages.
- Scale: 1.25 from 16 px. Sentence case throughout, with no all-caps labels.

## Signature moments

- **The Refractor** (homepage hero). The Q is live liquid glass: clear faces, dark defined bevels, a cobalt glass tail. A white fee beam drops from the Meteora source pill into the Q, and four coloured hook lines fan out of its tail to glass readout cards. On a 7.2 s loop, the pulse strikes and ripples the glass, crosses inside it, flashes the tail, then runs down each line and lights its card as it arrives. The glass floats, sways and follows the pointer. The split shown is labelled as an example.
- **$QUANTP showcase** (homepage, right under the hero). Quant Pad's own token on a graphite instrument: the chrome Q in a black-anodised tile, "Quant Pad" with a silver `$QUANTP`, the contract with a copy button, and a live readout (price, 24h change, market cap, volume, holders, burned, the curve's fill or "Graduated to Meteora DAMM v2", the fee charged now). Four hairline light lines rake its top-right corner. It always carries the disclosure: Quant Pad's own token, a fee split Quant Pad's payout engine pays out every hour from a wallet the team funds (not enforced on-chain), not financial advice. Every figure comes from `/api/quantp` (no store) and prints "—" in place while that is loading or down.
- **The fee flywheel** (homepage card, under the showcase). $QUANTP's flywheel: the 60/40 donut is live 3D glass on its cobalt stage, green holders, pink burn. The arrow ring turns clockwise, with pulses running its arcs. On a 7 s loop, trades flow into the hub, the fee rolls out, and a green and a pink stream land in their slices. The labels and the copy's step chips pulse with each beat. The big figure is the fee the pool really charges (2% on the curve, 5% after graduation, live); the 60/40 is the team's policy for the creator's share, paid out hourly by the payout engine, so the rows show what has really been paid to holders and bought back (`payouts` from `/api/quantp`), never an estimate.
- **Live scenes, static first.** Both scenes (`src/three/`) load lazily, only where WebGL works, and keep three.js out of the main bundle. The page first paints the static version: the chrome mark and SVG lines, and the flywheel still. The live scene fades in over it on its first frame, with no layout shift. Scenes pause off-screen and in hidden tabs, and step quality down on slow GPUs. If a scene fails or loses its GPU context, the static version comes back.
- **Holographic launch card.** Every coin page and the launch studio preview show the coin as a graphite trading card: chrome-framed art, silver ticker, and the hook loadout as coloured bars.
- **Live tape.** A graphite rail under the header. $QUANTP is pinned at its left end at every width (price and 24h change; the mark drops below 375 px), and real trending coins run beside it, fading in from under the pin and pausing on hover. With no coins to run (the store is down) the pin has the rail to itself and adds the market cap. From 1280 px the header also carries a small $QUANTP price pill, the mobile menu a $QUANTP row with Buy, and the footer the contract with a copy button.

## Accessibility

- Visible cobalt focus rings, labelled controls, `aria-pressed` segmented controls and dialog focus return.
- Everything works at 320 px wide.
- Reduced motion stops the sway, pulses, tape, glint and card tilt. The hero shows a still glass frame, the flywheel shows its still image, and the theme switches instantly.
- 3D canvases are decoration (`aria-hidden`). Every label, percentage and caption is real text.
