export default function TermsPage() {
  return (
    <div className="wrap prose-page">
      <article className="prose">
        <h1>Terms of use</h1>
        <p className="muted">
          Plain-language terms for using Quant Pad. Read them before launching or trading.
        </p>
        <h2>What Quant Pad is</h2>
        <p>
          Quant Pad is software that builds Solana transactions for Meteora and for the Quantum
          Hooks program. You sign every transaction in your own wallet. Quant Pad does not custody
          funds, does not hold private keys and cannot reverse transactions.
        </p>
        <h2>Your responsibility</h2>
        <ul>
          <li>
            You are responsible for what you launch, including names, images and links, and for
            complying with the laws that apply to you.
          </li>
          <li>
            Do not launch coins that impersonate people, brands or projects, or that infringe
            anyone’s rights.
          </li>
          <li>
            Tokens launched here have no intrinsic value and no promise of returns. You can lose
            everything you spend.
          </li>
        </ul>
        <h2>Third parties</h2>
        <p>
          Coins are created and traded through Meteora’s Dynamic Bonding Curve and DAMM v2, which
          are operated by third parties with their own fees, rules and admin powers. Their changes
          can affect coins launched here, including stopping Quantum Hooks.
        </p>
        {/* DRAFT: the owner or counsel approves this section before it ships. It is kept word for
            word the same as documentation/reference/terms-of-use.md. */}
        <h2>$QUANTP and its payout engine</h2>
        <p>
          $QUANTP is Quant Pad’s own token, and Quant Pad promotes it on this site. It did not
          launch through Quant Pad’s launch flow: it launched through Midas on Meteora, and Quantum
          Hooks do not route its fees.
        </p>
        <ul>
          <li>
            The team may send SOL to a payout wallet, from which Quant Pad’s payout engine pays
            holders in SOL and buys back and burns $QUANTP. These payouts and buybacks are the
            team’s discretionary policy, not an obligation: the team can change, pause or stop them
            at any time, and any run can pay nothing. No on-chain program enforces them.
          </li>
          <li>
            Holding $QUANTP gives you no right to any payout, buyback, burn or other payment, and no
            share in Quant Pad or its fees.
          </li>
          <li>
            You are responsible for any taxes on what you receive, buy or sell, and for reporting it
            where you live.
          </li>
          <li>
            $QUANTP and its payouts are not offered where they are prohibited. Do not buy or hold it
            where the laws that apply to you do not allow it.
          </li>
        </ul>
        <h2>No warranty</h2>
        <p>
          The software is provided as is, without warranties of any kind. Smart contracts can
          contain bugs. Quant Pad is not liable for losses arising from its use, to the extent the
          law allows.
        </p>
        <h2>Content</h2>
        <p>
          Quant Pad may hide coins from its own pages for any reason. Hidden coins remain on-chain
          and on Meteora.
        </p>
      </article>
    </div>
  )
}
