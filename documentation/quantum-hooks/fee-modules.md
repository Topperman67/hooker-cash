---
description: "The four places a Quantum coin's creator fees can go: Creator share, Quantum Burn, Entanglement and Fusion."
icon: diagram-project
---

# Fee modules

Each fee pulse is split across four modules, by the allocation the launcher fixed at launch. The allocation always adds up to 100%.

<table data-view="cards">
  <thead>
    <tr>
      <th></th>
      <th></th>
      <th data-hidden data-card-cover data-type="files"></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Creator share</strong></td>
      <td>Paid to the launcher every pulse.</td>
      <td><a href="../.gitbook/assets/module-creator.jpg">module-creator.jpg</a></td>
    </tr>
    <tr>
      <td><strong>Quantum Burn</strong></td>
      <td>Buys the coin and burns it.</td>
      <td><a href="../.gitbook/assets/module-burn.jpg">module-burn.jpg</a></td>
    </tr>
    <tr>
      <td><strong>Entanglement</strong></td>
      <td>Shares SOL with holders.</td>
      <td><a href="../.gitbook/assets/module-entanglement.jpg">module-entanglement.jpg</a></td>
    </tr>
    <tr>
      <td><strong>Fusion</strong></td>
      <td>Adds locked liquidity.</td>
      <td><a href="../.gitbook/assets/module-fusion.jpg">module-fusion.jpg</a></td>
    </tr>
  </tbody>
</table>

## Creator share

Sent to the launcher wallet in the same pulse that collects the fees. If [Superposition](launch-extras.md#superposition) wallets are set, they are paid their fixed share of this slice first.

## Quantum Burn

Accumulates in the coin's burn reserve. The keeper spends it in capped buys (on the Meteora bonding curve before graduation, on its DAMM v2 pool after) and burns every token bought in the same transaction. This shrinks the coin's supply.

If the keeper stalls, anyone can run the burn after a grace period.

## Entanglement

Accumulates in the holder reserve.

{% stepper %}
{% step %}
### Holding time

The keeper samples wallet balances about every 10 minutes (down to every 50 minutes while the coin is quiet). A wallet earns only for tokens it held through two samples in a row, so tokens bought just before a sample and sold just after earn nothing. A wallet that sells keeps what it earned up to then.

About once a day, and never more often than every 20 hours, the keeper splits the holder reserve by each wallet's average balance since the previous epoch and posts a merkle root for the epoch on-chain. A coin's first epoch waits until there are 12 hours of samples.
{% endstep %}

{% step %}
### Delay

The epoch's claims open after a delay set on-chain, 6 hours by default. Until then, Quant Pad can cancel the epoch, which returns its SOL to the holder reserve.
{% endstep %}

{% step %}
### Claim

Holders claim their SOL from the coin page until the epoch expires, 30 days after posting.
{% endstep %}

{% step %}
### Roll over

Unclaimed SOL rolls into the next epoch.
{% endstep %}
{% endstepper %}

## Fusion

Before graduation, the Fusion reserve simply accumulates. After graduation, it buys tokens and adds both sides to the well's Meteora DAMM v2 position, permanently locked.

{% hint style="info" %}
The program has no instruction to withdraw Fusion liquidity. Once added, it can never be removed.
{% endhint %}
