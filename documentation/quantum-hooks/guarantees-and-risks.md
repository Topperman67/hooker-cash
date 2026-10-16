---
description: "What the Quantum Hooks program guarantees, and the risks it can't remove."
icon: scale-balanced
---

# Guarantees and risks

## What you can rely on

* Allocations, split wallets and lock schedules are written before the coin exists. Nobody can edit them afterwards, including you and Quant Pad.
* Pulses, burns and Fusion are permissionless once the keeper's grace period passes, so hooks keep running even if Quant Pad's keeper stops.
* The keeper can post Entanglement epochs and run burns and Fusion, but it has no instruction that sends the well's SOL anywhere else.

## What you should know

* The keeper decides who each Entanglement epoch pays, from wallet balances it samples itself, so the amounts can't be recomputed from chain state. Epochs are at least 20 hours apart. An epoch's claims open only after a delay set on-chain, 6 hours by default. Until then, Quant Pad can cancel the epoch, which returns its SOL to the holder reserve.
* Meteora can upgrade its programs, and its operators can change a migrated pool's fees or pause it. No Meteora admin can reassign a coin's creator away from its well.
* Creator fees are a share of volume (the trading fee less Meteora's protocol share), so hooks scale with trading activity.
* Buybacks are market orders and can be front-run. Each burn is capped in size to limit that.

{% hint style="danger" %}
The Quantum Hooks program has not been independently audited yet.
{% endhint %}
