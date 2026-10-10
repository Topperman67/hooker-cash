// Copying a tiny price (src/components/Price.js) into a rich-text editor.
//
// A tiny price keeps its run of zeros in the page text at font-size 0 and draws the count with CSS.
// The plain text the browser copies is right (0.0000000412), but Chromium also copies HTML with
// every element's computed style inlined: the zero run arrives with font-size: 0 and the drawn
// count (generated content) not at all, so a mail composer, Docs or Word shows "0.0412", a price
// a million times too large. No CSS can avoid that serialization.
//
// So when a copy, or a dragged selection, includes a tiny price, the page writes both flavors
// itself: text/plain is the selection's text, exactly what the browser would copy, and text/html
// is the selected markup with each zero run made ordinary text and the drawn count left out, so
// it reads 0.0000000412 wherever it is pasted. Every other copy is left to the browser.

const TINY = '.price-tiny'
// A selection across table cells or list items keeps its table or list, as the browser's own copy
// does, so a pasted row is still a row.
const CONTAINERS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'OL', 'DL'])
// Content a reader does not see on the page: left out of the pasted HTML too.
const UNSEEN = 'script, style, template, [hidden], .sr-only'

const elementOf = (node) =>
  !node
    ? null
    : node.nodeType === 1
      ? node
      : node.nodeType === 9
        ? node.documentElement
        : node.parentElement || null

/** Whether `range` includes any part of a tiny price. */
export function touchesTinyPrice(range) {
  const root = elementOf(range?.commonAncestorContainer)
  if (!root) return false
  if (root.closest?.(TINY)) return true
  for (const el of root.querySelectorAll?.(TINY) || []) if (range.intersectsNode(el)) return true
  return false
}

/**
 * The selected markup of `range`, with each tiny price written as its plain decimal: the hidden
 * zero run becomes ordinary text and the drawn count (an empty <sub>) is dropped. Links and images
 * keep absolute URLs, so they still work where the HTML is pasted.
 */
export function selectedHtml(doc, range) {
  let content = range.cloneContents()
  for (
    let el = elementOf(range.commonAncestorContainer);
    el && CONTAINERS.has(el.tagName);
    el = el.parentElement
  ) {
    const shell = el.cloneNode(false)
    shell.append(content)
    content = shell
  }
  const box = doc.createElement('div')
  box.append(content)
  for (const el of box.querySelectorAll(UNSEEN)) el.remove()
  for (const run of box.querySelectorAll('.price-zero-run')) run.replaceWith(run.textContent)
  for (const count of box.querySelectorAll('.price-zeros')) count.remove()
  for (const a of box.querySelectorAll('a[href]')) a.setAttribute('href', a.href)
  for (const img of box.querySelectorAll('img[src]')) img.setAttribute('src', img.src)
  return box.innerHTML
}

/**
 * Writes the current selection to `data` (a copy event's clipboardData or a drag's dataTransfer)
 * when it includes a tiny price. Returns whether it did; the caller then prevents the browser's
 * own copy.
 */
export function writeSelection(doc, data) {
  if (!data?.setData) return false
  const selection = doc.getSelection?.()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false
  const ranges = []
  for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i))
  if (!ranges.some(touchesTinyPrice)) return false
  const html = ranges.map((range) => selectedHtml(doc, range)).join('')
  data.setData('text/plain', selection.toString())
  data.setData('text/html', html)
  return true
}

// Text fields and editors copy their own value; never step in there.
const editable = (target) =>
  !!(target?.isContentEditable || target?.closest?.('input, textarea, select'))

const installed = new WeakSet()

/** Installs the copy and drag handlers on `doc`, once. */
export function installPriceCopy(doc = globalThis.document) {
  if (!doc?.addEventListener || installed.has(doc)) return
  installed.add(doc)
  doc.addEventListener('copy', (event) => {
    if (editable(event.target)) return
    if (writeSelection(doc, event.clipboardData)) event.preventDefault()
  })
  // Dragging selected text carries the same two flavors as copying it. A drag of a link or an
  // image that is not part of the selection keeps the browser's own data.
  doc.addEventListener('dragstart', (event) => {
    if (editable(event.target)) return
    const selection = doc.getSelection?.()
    if (!selection?.containsNode?.(event.target, true)) return
    writeSelection(doc, event.dataTransfer)
  })
}
