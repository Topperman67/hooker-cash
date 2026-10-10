# Quant Pad design

**Concept.** Quant Pad is the double-slit experiment applied to a memecoin's fees. A stream of creator-fee
quanta passes through the coin's well and lands on four detectors, one per hook. The homepage
wave field renders this literally, and the rest of the interface stays quiet so it can be the one
memorable moment.

## Colour

| Token                 | Value                       | Use                                                    |
| --------------------- | --------------------------- | ------------------------------------------------------ |
| `--ink`               | `#0c0a1f`                   | Page background ("cryostat" ink, not neutral black)    |
| `--surface` / `-2/-3` | `#15122e` … `#241f50`       | Panels, hovered rows, selected segments                |
| `--line`              | `#2a2550`                   | 1px structure lines                                    |
| `--text` / `-2/-3`    | `#ece9ff` … `#7b75ad`       | Primary, secondary, tertiary text                      |
| `--foil`              | cyan → violet → pink → gold | Thin-film spectrum: wordmark, logo and hero field only |
| `--buy` / `--sell`    | `#3ef0a0` / `#ff5c8a`       | Trade direction only                                   |

Each hook owns one spectral colour, used everywhere it appears (sliders, allocation bar, reserves,
detector bands):

- Creator `#d9d4ff`
- Quantum Burn `#ffc857`
- Entanglement `#6be8ff`
- Fusion `#ff8ad8`
- Superposition `#b69cff`
- Time Dilation `#9effd2`

## Type

- **Unbounded** (variable): headings, wordmark, step numerals. Wide geometric forms for the "flashy" brief.
- **Manrope** (variable): interface and numbers, with tabular figures enabled globally so prices and balances align.
- Scale: 1.25 ratio from 16px. Headlines use `text-wrap: balance`. Sentence case throughout, with no all-caps labels.

## Layout and components

- Data surfaces (tables, tickets, reserves) use 12px corners and 1px lines. Hero surfaces use 20px.
- The hook grid is drawn with shared 1px gutters and a hook-coloured top rule, not floating cards.
- The only numbered sequences are real sequences: the three launch steps and the studio sections.
- Motion: the wave field animation (paused off-screen, static under reduced motion) plus feedback for user actions. There are no scroll-reveal effects.

## Accessibility

- Visible focus rings (`--focus`), labelled controls, `aria-pressed` segmented controls and dialog focus return.
- Everything works at 320px wide. Reduced motion is respected.
