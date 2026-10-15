---
description: "The four places a Quantum coin's creator fees can go: Creator share, Quantum Burn, Entanglement and Fusion."
icon: diagram-project
---

# Fee modules

Each fee pulse is split across four modules, by the allocation the launcher fixed at launch. The allocation always adds up to 100%.

| Module                            | What it does                  |
| --------------------------------- | ----------------------------- |
| [Creator share](#creator-share)   | Paid to the launcher every pulse |
| [Quantum Burn](#quantum-burn)     | Buys the coin and burns it    |
| [Entanglement](#entanglement)     | Shares SOL with holders       |
| [Fusion](#fusion)                 | Adds locked liquidity         |

## Creator share

Sent to the launcher wallet in the same pulse that collects the fees. If [Superposition](launch-extras.md#superposition) wallets are set, they are paid their fixed share of this slice first.

## Quantum Burn

Accumulates in the coin's burn reserve. The keeper spends it in capped buys (on the Meteora bonding curve before graduation, on its DAMM v2 pool after) and burns every token bought in the same transaction. This shrinks the coin's supply.

If the keeper stalls, anyone can run the burn after a grace period.

## Entanglement

Accumulates in the holder reserve.

1. About once a day, and never more often than every 20 hours, the keeper snapshots wallet balances and posts a merkle root for the epoch on-chain.
2. The epoch's claims open after a delay set on-chain, 6 hours by default. Until then, Quant Pad can cancel the epoch, which returns its SOL to the holder reserve.
3. Holders claim their SOL from the coin page until the epoch expires, 30 days after posting.
4. Unclaimed SOL rolls into the next epoch.

## Fusion

Before graduation, the Fusion reserve simply accumulates. After graduation, it buys tokens and adds both sides to the well's Meteora DAMM v2 position, permanently locked.

{% hint style="info" %}
The program has no instruction to withdraw Fusion liquidity. Once added, it can never be removed.
{% endhint %}
