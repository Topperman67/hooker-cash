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

- **The Refractor** (homepage hero). A white fee beam enters the chrome Q, and four coloured hook lines fan out of its tail to labelled readouts. Pulses travel the lines, the Q sways gently, and the glint follows the cursor. The split shown is labelled as an example.
- **Holographic launch card.** Every coin page and the launch studio preview show the coin as a graphite trading card: chrome-framed art, silver ticker, and the hook loadout as coloured bars.
- **Live tape.** A graphite rail of real trending coins under the header. It is hidden when there is no data and pauses on hover.

## Accessibility

- Visible cobalt focus rings, labelled controls, `aria-pressed` segmented controls and dialog focus return.
- Everything works at 320 px wide.
- Reduced motion stops the sway, pulses, tape, glint and card tilt.
