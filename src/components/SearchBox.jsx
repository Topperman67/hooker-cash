import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { isAddress, QUANTP } from '../../shared/network.mjs'
import { isQuantpQuery } from './QuantpShowcase.jsx'

// The header's coin search. The shell renders it twice (in the header and in the mobile menu, one
// of them shown at a time), so each copy gets its own input id for its label. "Site search" tells
// this landmark apart from a page's own search form, like the market's.
export default function SearchBox({ onDone }) {
  const [q, setQ] = useState('')
  const navigate = useNavigate()
  const id = useId()
  return (
    <form
      className="topbar-search"
      role="search"
      aria-label="Site search"
      onSubmit={(e) => {
        e.preventDefault()
        const value = q.trim()
        if (!value) return
        navigate(
          isQuantpQuery(value)
            ? QUANTP.path
            : isAddress(value)
              ? `/coin/${value}`
              : `/market?q=${encodeURIComponent(value)}`,
        )
        setQ('')
        onDone?.()
      }}
    >
      <Search size={16} aria-hidden="true" />
      <label className="sr-only" htmlFor={id}>
        Search coins or paste a mint address
      </label>
      <input
        id={id}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search or paste a mint"
        autoComplete="off"
        spellCheck="false"
      />
    </form>
  )
}
