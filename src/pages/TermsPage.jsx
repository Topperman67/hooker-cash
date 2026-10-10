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
          Quant Pad is software that builds Solana transactions for pump.fun and for the Quantum
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
          Coins are created and traded through pump.fun and PumpSwap, which are operated by third
          parties with their own fees, rules and admin powers. Their changes can affect coins
          launched here, including stopping Quantum Hooks.
        </p>
        <h2>No warranty</h2>
        <p>
          The software is provided as is, without warranties of any kind. Smart contracts can
          contain bugs. Quant Pad is not liable for losses arising from its use, to the extent the
          law allows.
        </p>
        <h2>Content</h2>
        <p>
          Quant Pad may hide coins from its own pages for any reason. Hidden coins remain on-chain
          and on pump.fun.
        </p>
      </article>
    </div>
  )
}
