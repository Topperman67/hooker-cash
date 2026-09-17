import { Button } from './UI'
export default function TransactionStatus({ tx }) {
  return (
    <div className="transaction-status" aria-live="polite">
      {tx.status && <p>{tx.status}</p>}
      {tx.error && (
        <p className="form-error" role="alert">
          {tx.error}
        </p>
      )}
      {tx.pending && (
        <>
          <a
            href={`https://explorer.arc.io/tx/${tx.pending.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View submitted transaction ↗
          </a>
          {!tx.busy && <Button onClick={tx.resume}>Check confirmation</Button>}
        </>
      )}
    </div>
  )
}
