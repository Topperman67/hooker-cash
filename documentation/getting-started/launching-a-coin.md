---
description: "Create a Meteora coin from the Launch page, with or without Quantum Hooks."
icon: rocket
---

# Launching a coin

{% stepper %}
{% step %}
### Connect a wallet

Connect a Solana wallet such as Phantom, Solflare or Backpack.
{% endstep %}

{% step %}
### Describe your coin

On the [Launch page](https://quantpad.vercel.app/launch), add a name, ticker, artwork and optional links. Quant Pad publishes the metadata, and its address is stored in your token forever.
{% endstep %}

{% step %}
### Choose a launch type

Choose a **Quantum launch** (with hooks) or a **Standard** Meteora launch, where you are the creator and claim fees yourself. See [Quantum or Standard](#quantum-or-standard) below.
{% endstep %}

{% step %}
### Add a dev buy (optional)

Your dev buy executes in the same transaction that creates the coin, so nobody can buy before you.
{% endstep %}

{% step %}
### Approve in your wallet

Approve the transactions in your wallet. A Quantum launch first registers the hooks for the new mint, then creates the coin, then applies the [Time Dilation](../quantum-hooks/launch-extras.md#time-dilation) lock if you chose one.
{% endstep %}
{% endstepper %}

Launching costs about 0.02–0.03 SOL in network fees and account rent, plus any dev buy.

## Quantum or Standard

|                     | Quantum launch                                                       | Standard launch                    |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| Meteora creator     | The coin's own well, a program-controlled address                    | You                                |
| Creator fees        | Split automatically by the hooks you set at launch                   | You claim them yourself            |
| Trading tax         | 1%, 2%, 3% or 5%, you choose                                         | Fixed at 1%                        |
| Anti-sniper tax     | Not available                                                        | Optional                           |

The anti-sniper tax starts at 25% at launch and falls to the normal 1% over the first two minutes.

## Choosing your hooks

For a Quantum launch you split each fee pulse across the four [fee modules](../quantum-hooks/fee-modules.md). The allocation always adds up to 100%. The Launch page offers four presets to start from:

| Preset        | Creator share | Quantum Burn | Entanglement | Fusion |
| ------------- | ------------- | ------------ | ------------ | ------ |
| Deflationary  | 30%           | 70%          | 0%           | 0%     |
| Holder yield  | 25%           | 0%           | 75%          | 0%     |
| Balanced      | 30%           | 30%          | 20%          | 20%    |
| Creator max   | 100%          | 0%           | 0%           | 0%     |

You can also add [Superposition](../quantum-hooks/launch-extras.md#superposition) wallets to split your creator share, and a [Time Dilation](../quantum-hooks/launch-extras.md#time-dilation) lock on your dev buy.

{% hint style="warning" %}
Allocations, split wallets and lock schedules are written before the coin exists. Nobody can edit them afterwards, including you and Quant Pad. Check them carefully before you sign.
{% endhint %}

## After launch

Your coin trades on Meteora's Dynamic Bonding Curve. When the curve fills, it graduates to a Meteora DAMM v2 pool, and its liquidity is permanently locked.
