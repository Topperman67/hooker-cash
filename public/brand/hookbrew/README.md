# Hookbrew logo assets

Original liquid-glass artwork generated with the built-in image generation tool.

## Deliverables

| File | Dimensions | Use |
| --- | --- | --- |
| `hookbrew-logo.png` | 2172 × 724 | Horizontal flask symbol and Hookbrew wordmark |
| `hookbrew-icon.png` | 1254 × 1254 | Square symbol-only image |

Both PNGs retain the generated alpha channel and original image metadata. The light wordmark is intended for dark surfaces, including the app's current midnight `#090411`. The generated lettering visually follows rounded geometric Outfit-style forms; it is raster artwork, not typeset font text or an editable vector.

Use `/brand/hookbrew/hookbrew-logo.png` and `/brand/hookbrew/hookbrew-icon.png` as asset URLs. Preserve the original aspect ratios. Prefer at least 32 CSS pixels for the icon; 48 pixels keeps the liquid hook more distinct.

## Verification

- Visually checked the exact spelling: **Hookbrew**.
- Checked decoded pixel alpha: both files contain fully transparent background pixels and partially transparent glass/antialiased edges.
- The logo has 1,094,794 fully transparent pixels; the icon has 895,164.
- Visually reviewed both assets against `#11101c`, including icon sizes of 24, 32, 48, 64, and 128 CSS pixels and a 360-pixel-wide wordmark.
- Screenshot of the browser-rendered check: `artifacts/hookbrew-logo-check.png` (local verification artifact, ignored by Git).
- Rechecked the originals on the app's current `#090411` background at 24, 32, 48, 64, and 128 CSS pixels, with a 200-pixel navigation lockup. The wordmark reads **Hookbrew**; the liquid hook remains most distinct at 48 pixels and above.
- Current browser-rendered check: `artifacts/hookbrew-logo-midnight-check.png`; decoded alpha counts: `artifacts/hookbrew-logo-alpha-report.json`. The icon has one corner pixel with alpha 1/255; all other corners and the surrounding background are transparent. Neither image contains a baked-in checkerboard or opaque backdrop.
- Assets were copied without image conversion or alpha flattening.

## Generation prompts

### Square symbol

```text
Use case: logo-brand.
Asset type: original square symbol-only PNG app icon for Hookbrew, a Uniswap v4 programmable token launchpad.
Primary request: design ONE original compact liquid-glass brewing flask emblem, with a single bold curved hook formed by mint liquid suspended inside the flask. The hook is a clean continuous J-shaped liquid ribbon, stem descending and curling upward at its lower end, legible at small sizes. It represents software hooks and composing token mechanics.
Scene/backdrop: genuinely TRANSPARENT background with a real alpha channel, not white, black, or a rendered checkerboard. The logo will be placed on midnight #11101c.
Subject: front-facing low, broad brewing flask with a short neck, thick rounded clear-glass rim, softly sloping shoulders and stable rounded base. Large hook-shaped liquid ribbon in its center. Strong geometric silhouette, balanced negative space. The entire mark fits comfortably within a square canvas and occupies about 80 percent of its height.
Style: precision-crafted brand symbol with polished liquid-glass refraction, sculptural depth, restrained clean studio highlights, luminous yet clearly bounded edges. Simple geometry that reads at 32 and 48 pixels. Rounded, confident and modern.
Color palette: electric mint #a5e7d2 and ice blue #b9edff, subtle lavender #b4a1ff reflected along select glass edges, porcelain #f6f3ff highlights. Preserve contrast on a very dark background.
Constraints: one single centered flask mark, isolated cutout; actual transparency around the symbol and natural glass translucency inside it. No wordmark, no letters, no slogan, no watermark, no cast shadow or floor, no display pedestal, no badge or app tile, no repeated logo, no decorative stars, no complex laboratory details, no fish or fishing tackle. The hook is visibly made from liquid, not metal. This must feel like an elegant brand logo rather than a detailed illustration. Square high-resolution PNG.
```

### Horizontal logo

The square symbol was supplied as the identity reference.

```text
Use case: logo-brand. Asset type: transparent horizontal logo PNG for Hookbrew.
Input image: the existing Hookbrew flask symbol; it is the identity reference and must be preserved.
Create a single clean horizontal brand lockup: the EXACT reference flask symbol on the left, followed by the word "Hookbrew" on the right. Preserve its broad rounded glass silhouette, short thick rim, mint liquid hook curling upward, icy blue highlights and restrained lavender reflections. Do not redesign the symbol.
Text (verbatim): "Hookbrew" — capital H followed by lowercase o o k b r e w. Exactly these eight letters, correctly spelled; no other text. Use a confident rounded geometric sans-serif wordmark visually matching Outfit SemiBold: single-storey rounded forms, generous counters, balanced kerning, white-porcelain #f6f3ff with an extremely subtle cool mint cast. The wordmark must have a solid readable body with only a delicate glass edge highlight. No dark lettering and no outlined lettering.
Composition: wide approximately 3:1 landscape canvas; optically centered single-row symbol-and-wordmark lockup, generous but practical transparent padding. The symbol is roughly 1.5 times the wordmark cap height, and the space between them is about half a capital H width. Clear visual hierarchy at website navigation sizes.
Background: genuinely transparent PNG alpha, not a checkerboard illustration and not a solid backdrop. Designed for display on midnight #11101c. No shadows on a floor, no mockup, no border, no gradients in the background, no slogan, no watermarks or extra icons. Use the supplied logo mark without changing its identity. Polished final brand asset, not a presentation board.
```
