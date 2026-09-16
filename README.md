# Hooker Cash — UX vamp

Full front-end remake/vamp of [hooker.cash](https://hooker.cash/) — the Uniswap V4 meme launchpad on **Arc**.

Scraped + structured with **Scrapling** (`DynamicFetcher`), then rebuilt as a clean Vite + React SPA.

## What’s included

| Surface | Notes |
|--------|--------|
| **Access gate** | Four-rule confirm wall (localStorage unlock) |
| **Home** | Hero, programmable liquidity stack, module lanes, feature grid, live floor cards |
| **Market** | Tile + list feed, sort/filter |
| **Create / Hook Builder** | Name/symbol, quote, fee tier, 70/30 split, gate + value module toggles, launch preview |
| **Trade** | Chart shell + swap box (demo quotes) |
| **Liquidity** | Sealed pool table |
| **Leaderboard** | Volume board + activity tape |
| **Modules** | Full hook registry (Velvet Rope, Bouncer, Ticker Tape, JIT Guard, Ashtray, Champagne Room, Make It Rain, Money Flip, Sugar Daddy) |
| **Agents** | MCP tool IA placeholder |
| **Docs / Terms** | Guide copy + NFA |

## Stack

- Vite 6 + React 19 + React Router 7
- CSS design tokens matched to production (Arc cyan accent on `#08070a`)
- Demo market data in `src/data.js` — swap for indexer when wiring mainnet

## Run

```bash
npm install
npm run dev
```

```bash
npm run build
npm run preview
```

## Deploy

Static SPA. `vercel.json` rewrites all routes to `index.html`.

```bash
vercel link --project hooker-cash --yes
vercel deploy --prod --yes
```

## Honest scope

- **UI/UX vamp** of the launchpad product surface — not a bytecode fork of production contracts.
- Wallet connect is a **demo** address stub; wire RainbowKit/wagmi + factory ABIs for live launches.
- Not affiliated with the production Hooker team unless you say so.

## Reference

- Live product: https://hooker.cash/
- Contracts research (related ecosystem): https://github.com/gigahooker/hookers-contracts
