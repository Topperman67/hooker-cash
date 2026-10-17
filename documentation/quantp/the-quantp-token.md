---
description: "Quant Pad's own token: the contract, the real fees, how its 60/40 split is paid out every hour, how to trade it on Quant Pad, and the risks."
icon: coins
---

# The $QUANTP token

$QUANTP is Quant Pad's own token. It launched via [Midas](https://trymidas.fun) on Meteora's Dynamic Bonding Curve, not through Quant Pad's launch flow, and its curve has since graduated to a Meteora DAMM v2 pool.

{% hint style="warning" %}
$QUANTP's fee split is paid out every hour by Quant Pad's payout engine, from a wallet the team funds; nothing on-chain enforces it. Quant Pad is promoting its own token here, memecoins are extremely risky, and nothing on this page is financial advice.
{% endhint %}

<a href="https://www.quantpad.company/quantp" class="button primary" data-icon="arrow-right-arrow-left">Trade $QUANTP on Quant Pad</a> <a href="https://dexscreener.com/solana/85tswjnucttvgvtqzwzchnbfmor4dv581a3wg7buzgvf" class="button secondary" data-icon="chart-line">Chart</a> <a href="https://solscan.io/token/7cAJWZyyG7VqFJ4HzAxKNG8Xch6mJY4CfwPbfP6cJKiy" class="button secondary" data-icon="magnifying-glass">Solscan</a>

## Contract

| | |
| --- | --- |
| Contract (mint) | `7cAJWZyyG7VqFJ4HzAxKNG8Xch6mJY4CfwPbfP6cJKiy` |
| Token program | Token-2022 |
| Decimals | 6 |
| Supply | 1,000,000,000, fixed at launch (burns can only lower it) |
| Mint authority | Revoked: no more can ever be minted |
| Freeze authority | Revoked: no account can be frozen |
| Bonding curve pool (Meteora DBC) | `85TSwjnucTtvgvtqzWzChNBfmoR4Dv581A3WG7Buzgvf` |
| Pool after graduation (Meteora DAMM v2) | `EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw` |

## Transfer hook

While $QUANTP traded on its bonding curve, every transfer ran a transfer hook: program `4xh25C2V65F5buKwKzYpSKHdhz7xTfNTJofCgB1WTDrE`, which Midas runs and can upgrade. It checked a launch whitelist, open since launch day, and took no fee.

Meteora removes the hook when a curve graduates. $QUANTP's curve has graduated, so its transfers no longer run a hook.

## Fees

| Where it trades | Fee on every buy and sell | Where the fee goes |
| --- | --- | --- |
| Meteora bonding curve, before graduation | 2%, in SOL | Meteora 20%, Midas (the launch partner) 8%, the creator 72% |
| Meteora DAMM v2 pool, after graduation | 5% | Meteora's protocol share, then the pool's liquidity positions |

Nothing on-chain charges more than this: the transfer hook took no fee, and the token has no transfer fee. Any Quant Pad platform fee on a trade made through Quant Pad is shown before you sign, as a separate transfer.

## How the 60/40 split is paid out

The team sends the creator's share of $QUANTP's trading fees to its payout wallet, [`GLAn4nGLTcwCmPJsTkLL4LrFaWCADb5dGXKjNCd2FAvn`](https://solscan.io/account/GLAn4nGLTcwCmPJsTkLL4LrFaWCADb5dGXKjNCd2FAvn). Every hour, Quant Pad's payout engine releases a slice of that wallet's SOL and splits it:

* **60% to holders**, in SOL, to each wallet holding at least **0.15% of the supply** at that moment, in proportion to its balance. Pools and the team's own wallets are not paid.
* **40% to buyback and burn**: it buys $QUANTP in its DAMM v2 pool and burns it in the same transaction.

The slice is a share of the wallet per day that grows with the market cap: 20% a day below $100k, 50% up to $1M, and all of it above, spread over the day's 24 runs. So the SOL trickles out, a little at a time while the market cap is small and faster as it grows.

The engine runs on Quant Pad's server, not in an on-chain program, so payouts depend on the team funding the wallet. Every payout, buyback and burn is a public transaction: the [$QUANTP page](https://www.quantpad.company/quantp) lists them all, with what has actually been paid and burned so far.

## Trade $QUANTP on Quant Pad

{% stepper %}
{% step %}
### Connect a wallet

Connect a Solana wallet such as Phantom, Solflare or Backpack.
{% endstep %}

{% step %}
### Open $QUANTP

Open [$QUANTP on Quant Pad](https://www.quantpad.company/quantp), or search "quantp" in the search box.
{% endstep %}

{% step %}
### Check and approve

Enter an amount, check the fee and the minimum you receive, and approve in your wallet. Your slippage limit is enforced on-chain.
{% endstep %}
{% endstepper %}

Quant Pad trades $QUANTP on its bonding curve before graduation and in its DAMM v2 pool after, and switches on its own.

## Risks

* Memecoins are extremely volatile and most lose all value.
* Quant Pad is promoting its own token, so it is not a neutral party.
* Holder payouts and buybacks depend on the team funding the payout wallet and on Quant Pad's server running the engine. No on-chain program enforces them.
* Meteora can upgrade its programs, and its operators can change a migrated pool's fees or pause it.
* Nothing here is financial advice. Read [Safety](../reference/safety.md) before you trade.
