// A token price. Tiny prices show their run of zeros as a count in the brand font ("0.0₇412"),
// drawn so that the page text stays the plain decimal:
//   - the zeros the count stands for stay in the text, hidden from view (.price-zero-run), so
//     find-in-page, screen readers and plain-text copies get 0.0000000412;
//   - the count itself is CSS generated content on an aria-hidden <sub> (.price-zeros), which is
//     neither copied nor read out;
//   - a copy (or drag) that includes one writes its own HTML with the zeros as ordinary text, so
//     rich-text pastes read 0.0000000412 too (src/lib/priceCopy.js, installed once per document);
//   - the title shows the full decimal on hover.
// Plain createElement (no JSX) so the unit tests can render it without a JSX transform.
import { createElement as h, useEffect } from 'react'
import { priceParts } from '../lib/format.js'
import { installPriceCopy } from '../lib/priceCopy.js'

export default function Price({ value }) {
  useEffect(() => installPriceCopy(), [])
  const parts = priceParts(value)
  if (!parts) return '—'
  if (!parts.zeros) return parts.text
  return h(
    'span',
    { className: 'price-tiny', title: parts.text },
    '0.0',
    h('span', { className: 'price-zero-run' }, '0'.repeat(parts.zeros - 1)),
    h('sub', { className: 'price-zeros', 'data-zeros': parts.zeros, 'aria-hidden': 'true' }),
    parts.digits,
  )
}
