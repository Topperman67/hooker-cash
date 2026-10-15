---
description: "Trading taxes, Quant Pad's own fees and what it costs to launch a coin."
icon: receipt
---

# Fees

## Trading tax

Every Quant Pad coin has a trading tax, shown on its coin page.

| Launch type | Trading tax                            |
| ----------- | -------------------------------------- |
| Standard    | 1%                                     |
| Quantum     | 1%, 2%, 3% or 5%, chosen by the launcher |

Standard launches can also opt into an anti-sniper tax: 25% at launch, falling to 1% over the first two minutes.

Meteora keeps its protocol share of the tax, and the rest goes to the coin's creator. For a Quantum coin, the creator is the coin's [well](../quantum-hooks/overview.md#key-terms), so that share is split by its [hooks](../quantum-hooks/fee-modules.md).

## Quant Pad platform fee

Any Quant Pad platform fee on trades and dev buys made through Quant Pad is shown before you sign, as a separate transfer.

## Quantum Hooks protocol share

Quantum Hooks can take a protocol share of each fee pulse before it is split. It is capped at 10% on-chain, and any share is shown before you sign.

## Launch cost

Launching costs about 0.02–0.03 SOL in network fees and account rent, plus any dev buy.
