# Hookbrew — charcoal and Robinhood green

## Palette and identity

Use charcoal #111512 for the canvas, graphite #1B211D for panels, warm white #F2F5EE for headings, muted sage #9CA89F for secondary text, lime #CCFF00 for primary actions, and leaf #85C79A for supporting accents. Broad surfaces remain charcoal; reserve the brightest green for interaction, selected states and key highlights. Borders are quiet neutral green. Keep errors and negative trades distinct from success using rose. Do not recolor third-party marks or the user's supplied RH network image.

Outfit carries headings and token identity; DM Sans carries controls and financial data. Preserve the Hookbrew flask silhouette and wordmark, rendered with a neutral glass treatment. The RH mark uses the exact supplied Ethereum/Robinhood composite PNG with its original colors and transparency.

Use 450-weight display typography with close tracking: 50–88px for the home headline, 34–52px for page titles, 25–32px for section headings. Body copy is 13–15px with generous line height; supporting values use tabular numerals. Align content to a shared 1320px maximum workspace. Surfaces distinguish functional groups, not every piece of text. Keep vivid green concentrated on actions and the hook object; inactive navigation icons use neutral tones.

## Navigation

The compact left rail and expanded sidebar use nine original SVGs in public/brand/navigation/robinhood. The symbols are a house for overview, candlesticks for market, a brewing flask and plus for creation, opposing arrows for trade, a droplet for liquidity, a podium and star for rankings, layered modules for the hook registry, an automation network for agents, and an open book for documentation. Use consistent 32-unit canvases, 1.8-unit round strokes, lime outlines and sage details. The older platinum PNGs are historical assets.

Desktop starts with a compact rail. All nine icons link directly to their routes and expose their labels on hover and keyboard focus. The active row has a restrained green surface, bright icon and selection marker. The logo or expansion arrow opens the labeled sidebar; choosing a route or closing the menu restores the rail. Keep existing layout breakpoints and short-window compaction. Mobile uses a modal drawer with focus containment, Escape dismissal, a backdrop and focus restoration. Hidden navigation stays inert. Link names provide accessible labels, so artwork uses empty alt text.

The Robinhood Chain network card uses actual connection and block data, the supplied RH mark, and the Robinhood explorer link. Compact or hide supplementary network details on short screens so every navigation destination stays accessible.

## Home

Use an open, left-aligned headline beside an architectural illustration of swaps, the hook and the Uniswap V4 pool. The headline stays soft white. The hook is the vivid green centerpiece; its surrounding panels remain transparent. A restrained dotted field grounds the object. Pointer movement tilts the layers and shifts their highlights; hover separates the stack. Use CSS 3D transforms with at most one pointer update per animation frame. Disable decorative movement for reduced-motion and touch input.

The supporting market section displays actual recent launches, loading and empty states, plus explicit retry behavior when data is unavailable. Never invent market statistics.

Show the network, pool technology and currency in a compact foundation strip. Follow with fresh markets and a studio invitation, then introduce the seven real hook modules. Explain opening terms, creator payouts and permanent seed liquidity using actual protocol settings. The launch fee and valuation bounds come from shared network configuration. These are product settings, not invented activity metrics.

## Launch studio and terminal

Place the studio heading above the working surface. On wide screens, show the editor beside a sticky draft summary containing actual token identity, valuation, fee tier, recipe and launch fee. Clearly label it Draft; it is never a deployed-token preview. Hide the secondary summary on small screens, where the form and final review carry those values. The Hook stage gets the full workspace width because its builder has a dedicated recipe panel.

Preserve the sequence Pool → Hook → Token → Payouts → Review. Keep all five steps visible on mobile. Pool uses valuation and fee sliders; Hook uses selectable recipes; Token contains identity and artwork; Payouts configures founder buys, vesting and wallet splits. Review presents exact values and edit links before simulation and wallet signing. Selected controls use green; labels and financial values remain readable neutral tones.

The terminal prioritizes the price chart, trade ticket, activity and rewards. Align inputs and amounts consistently. Positive trades use green and negative trades use rose; lime identifies actions and the chart crosshair. Uploaded token artwork and verified metadata connect the launch studio to the resulting market. No decorative sample candles or invented balances.

## Hook workbench

The registry is a readable catalog, grouped into opening controls and fee allocation. Each desktop row aligns the module identity, its purpose and its detailed behavior. On mobile these form a single column with consistent icon alignment. Preserve every caveat and behavioral detail. Community recipes remain separate because those represent actual deployments.

The module list is the main working area. A compact sticky recipe panel shows installed modules, exact per-currency fee allocation and build status; it stacks below the controls on mobile. Module colors use lime, sage, mint, fern, olive and moss, with labels and symbols carrying meaning independently of color. Color is never an unverified security rating. Installing a module reveals only its relevant controls. A confirmed recipe shows its actual contract address; a draft never implies deployment.

## Behavior and accessibility

Preserve QuickLiquid refraction, its system accessibility preferences and browser fallbacks. No user-facing lightweight switch is added. Destroy lenses and listeners on unmount. Keep visible keyboard focus, readable disabled states, mobile close controls and no horizontal overflow.

Use subtle lens bevels on workspace surfaces and controls; reserve stronger refraction for the architecture illustration. Mobile headers use a dedicated second row for search, compact network artwork and an unobscured wallet control. Header contents must stay within the header and above page titles at 320px, 390px, 768px and desktop widths. Verify every route, the access gate, populated markets and the trading terminal.

Real data takes priority. Token identities come from contracts or verified metadata; markets, prices, trades, balances, liquidity locks, quotes and receipts must come from actual sources. Architecture graphics are illustrations. Agent transaction execution remains unavailable.
