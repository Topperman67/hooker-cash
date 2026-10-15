---
description: "How a Quant Pad coin's creator fees flow from trades into its well and out through the hooks."
icon: atom
---

# How Quantum Hooks work

Quantum Hooks work on the one stream every coin has: its creator fees. A Quant Pad coin's Meteora creator is the coin's own **well**, a program-controlled address, and the hooks decide where every lamport goes.

<figure><img src="../.gitbook/assets/diagram-fee-flow.jpg" alt="Trades pay a trading tax. Meteora keeps its share and the creator fee flows into the coin's well. Each pulse splits the well's fees four ways: Creator share is paid to the launcher, Quantum Burn buys and burns the coin, Entanglement shares SOL with holders, and Fusion adds locked liquidity. An optional protocol share, capped at 10%, can be taken first."><figcaption></figcaption></figure>

## Key terms

* **Well:** a program-controlled address unique to each Quantum coin. It is the coin's Meteora creator, so creator fees accumulate for it.
* **Pulse:** collects the well's creator fees and splits them by the allocation fixed at launch.
* **Keeper:** Quant Pad's automated service. It runs pulses, burns and Fusion deposits, and posts Entanglement epochs. If the keeper stops, anyone can run pulses, burns and Fusion after a grace period.

## Protocol share

Quantum Hooks can take a protocol share of each fee pulse before it is split. The share is capped at 10% on-chain, and any share is shown before you sign.

## Learn more

<table data-view="cards">
  <thead>
    <tr>
      <th></th>
      <th></th>
      <th data-hidden data-card-cover data-type="files"></th>
      <th data-hidden data-card-target data-type="content-ref"></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Fee modules</strong></td>
      <td>Where each slice of a pulse goes.</td>
      <td><a href="../.gitbook/assets/card-hooks.jpg">card-hooks.jpg</a></td>
      <td><a href="fee-modules.md">fee-modules.md</a></td>
    </tr>
    <tr>
      <td><strong>Launch extras</strong></td>
      <td>Superposition and Time Dilation.</td>
      <td><a href="../.gitbook/assets/extra-superposition.jpg">extra-superposition.jpg</a></td>
      <td><a href="launch-extras.md">launch-extras.md</a></td>
    </tr>
    <tr>
      <td><strong>Guarantees and risks</strong></td>
      <td>What the program enforces, and what it can't.</td>
      <td><a href="../.gitbook/assets/module-fusion.jpg">module-fusion.jpg</a></td>
      <td><a href="guarantees-and-risks.md">guarantees-and-risks.md</a></td>
    </tr>
  </tbody>
</table>

<a href="https://www.quantpad.company/launch" class="button primary" data-icon="rocket">Launch with Quantum Hooks</a>
