import { claimTiming } from '../lib/claims.js'
import { countdown, duration, sol, toSol } from '../lib/format.js'

// The Quantum panel's Entanglement claims: epochs whose claims have not opened yet (a countdown,
// never a Claim button: the program refuses a claim before claimStart and the epoch may still be
// cancelled) and the connected wallet's rewards, each with a Claim button only once it is open.
// `now` is unix seconds; `onClaim(item)` sends the claim. An epoch's `window` ({from, to}, unix
// seconds) is the stretch of holding it pays for.
const held = (e) => Number(e.window?.to) - Number(e.window?.from)

export default function EntanglementClaims({ upcoming = [], items = [], now, busy, onClaim }) {
  return (
    <>
      {upcoming.length > 0 && (
        <div className="quantum-block">
          <h3>Next Entanglement {upcoming.length > 1 ? 'epochs' : 'epoch'}</h3>
          <ul className="activity">
            {upcoming.map((e) => (
              <li key={e.index}>
                <span>
                  Epoch {e.index + 1}: <span className="num">{sol(toSol(e.total))}</span> for{' '}
                  {e.holders} holder{e.holders === 1 ? '' : 's'}
                  {held(e) > 0 && `, by average balance over ${duration(held(e))}`}
                </span>
                <span className="faint">
                  Claims open in {countdown(Number(e.claimStart) - now)}
                </span>
              </li>
            ))}
          </ul>
          <p className="faint claim-note">
            An epoch’s claims open after a delay set on-chain. Until then Quant Pad can cancel the
            epoch, which returns its SOL to the holder reserve.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div className="quantum-block">
          <h3>Your Entanglement rewards</h3>
          {items.map((c) => {
            const timing = claimTiming(c, now)
            return (
              <div className="claim-row" key={c.index}>
                <span className="num">{sol(toSol(c.amount))}</span>
                <span className="faint">epoch {c.index + 1}</span>
                {timing.state === 'open' ? (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!!busy}
                    onClick={() => onClaim(c)}
                  >
                    Claim
                  </button>
                ) : (
                  <span className="faint claim-wait">
                    {timing.state === 'pending'
                      ? `Claims open in ${countdown(timing.opensIn)}`
                      : 'Expired'}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
