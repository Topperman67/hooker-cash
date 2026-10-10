// Frontend round 2: Entanglement claims that open later (K1), the launch summary's platform fee,
// tiny-price zero counts drawn in the brand font (and copied as the full decimal, rich text
// included), unique search ids and labelled landmarks, coins that migrated off pump.fun.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Keypair } from '@solana/web3.js'
import { build } from 'esbuild'
import { countdown, price, priceParts } from '../../src/lib/format.js'
import { claimTiming, nextRefresh, OPEN_SLACK, upcomingEpochs } from '../../src/lib/claims.js'
import { chargedPlatformFee, platformFee } from '../../src/lib/amounts.js'
import { RENT_EXEMPT_MINIMUM } from '../../src/lib/txflow.js'
import { explainCustomError, PROGRAMS, registerQuantumIdl } from '../../src/lib/txerrors.js'
import Price from '../../src/components/Price.js'
import {
  installPriceCopy,
  selectedHtml,
  touchesTinyPrice,
  writeSelection,
} from '../../src/lib/priceCopy.js'

// src/lib/solana.js builds its Connection from window.location at import time.
globalThis.window ??= { location: { origin: 'http://127.0.0.1:9' } }
const solana = await import('../../src/lib/solana.js')

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const SUBSCRIPT_DIGITS = /[₀-₉]/
const text = (html) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")

// JSX components, bundled with esbuild (React included) and loaded as CommonJS.
async function loadJsx(contents, plugins = []) {
  const result = await build({
    plugins,
    stdin: { contents, resolveDir: ROOT, loader: 'jsx', sourcefile: 'entry.jsx' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const dir = mkdtempSync(join(tmpdir(), 'qp-frontend-r2-'))
  try {
    const file = join(dir, 'bundle.cjs')
    writeFileSync(file, result.outputFiles[0].text)
    return createRequire(import.meta.url)(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ui = await loadJsx(`
  export { renderToStaticMarkup } from 'react-dom/server'
  export { createElement } from 'react'
  export { MemoryRouter } from 'react-router-dom'
  export { default as EntanglementClaims } from './src/components/EntanglementClaims.jsx'
  export { default as SearchBox } from './src/components/SearchBox.jsx'
`)
const render = (Component, props, ...children) =>
  ui.renderToStaticMarkup(ui.createElement(Component, props, ...children))

// ---------- build-defect-5: tiny prices ----------

test('tiny prices split into a zero count and digits; the plain text is the full decimal', () => {
  assert.deepEqual(priceParts(0.0000000412), { text: '0.0000000412', zeros: 7, digits: '412' })
  assert.deepEqual(priceParts(0.00000002796), { text: '0.00000002796', zeros: 7, digits: '2796' })
  assert.deepEqual(priceParts(0.000412), { text: '0.000412', zeros: 3, digits: '412' })
  // Rounding that carries into the next power of ten keeps the count right.
  assert.deepEqual(priceParts(0.00099999), { text: '0.001', zeros: 2, digits: '1' })
  assert.deepEqual(priceParts(0.05), { text: '0.05' })
  assert.deepEqual(priceParts(1234.5), { text: '1,235' })
  for (const bad of [null, undefined, 0, -1e-8, NaN, Infinity]) {
    assert.equal(priceParts(bad), null)
    assert.equal(price(bad), '—')
  }
  assert.equal(price(0.0000000412), '0.0000000412')
  // Every tiny price reads back as (about) the same number, and never uses subscript digits.
  for (let i = 0; i < 400; i++) {
    const value = Math.random() * 10 ** -(3 + Math.floor(Math.random() * 12))
    if (!(value > 0)) continue
    const parts = priceParts(value)
    assert.ok(!SUBSCRIPT_DIGITS.test(parts.text), parts.text)
    assert.ok(Math.abs(Number(parts.text) - value) / value < 1e-3, `${value} → ${parts.text}`)
    if (value < 0.001) {
      assert.equal(parts.text, `0.${'0'.repeat(parts.zeros)}${parts.digits}`)
      assert.match(parts.digits, /^[1-9]\d{0,3}$/)
    }
  }
})

test('the Price component draws the count in markup and keeps the full decimal as its text', () => {
  const html = renderToStaticMarkup(createElement(Price, { value: 0.0000000412 }))
  assert.ok(!SUBSCRIPT_DIGITS.test(html), html)
  // The visible count is generated content on an aria-hidden <sub>: never copied or read out.
  assert.match(html, /<sub class="price-zeros" data-zeros="7" aria-hidden="true"><\/sub>/)
  assert.match(html, /^<span class="price-tiny" title="0\.0000000412">0\.0</)
  // Text content (what is copied, searched and read) is the plain decimal, the zero run included.
  assert.equal(text(html), '0.0000000412')
  assert.match(html, /<span class="price-zero-run">000000<\/span>/)
  // Ordinary prices and missing ones are plain text.
  assert.equal(renderToStaticMarkup(createElement(Price, { value: 0.05 })), '0.05')
  assert.equal(renderToStaticMarkup(createElement(Price, { value: null })), '—')

  const css = source('src/styles/components.css')
  assert.match(css, /\.price-zeros::before\s*{\s*content:\s*attr\(data-zeros\);/)
  const run = /\.price-zero-run\s*{([^}]*)}/.exec(css)[1]
  assert.match(run, /font-size:\s*0;/)
  // Hidden by size, not taken out of flow: an absolutely positioned run would be blockified and
  // copying would put line breaks around the zeros.
  assert.doesNotMatch(run, /position|display/)
})

test('every price on screen goes through the Price component', () => {
  for (const file of [
    'src/components/CoinList.jsx',
    'src/components/Tape.jsx',
    'src/components/TradesTable.jsx',
    'src/pages/CoinPage.jsx',
  ]) {
    const code = source(file)
    assert.match(code, /<Price value=\{/, file)
    assert.doesNotMatch(code, /\bprice\(/, file)
  }
})

// ---------- build-defect-5 (round 2): copying a tiny price into rich text ----------

// A small DOM stand-in, enough for src/lib/priceCopy.js: elements with a tag, attributes and
// children, text nodes, fragments, simple selectors (tag, .class, [attr], comma lists).
const BASE = 'http://127.0.0.1:4350/coin/page'
class FakeNode {
  parentNode = null
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null
  }
  remove() {
    const parent = this.parentNode
    if (parent) parent.children.splice(parent.children.indexOf(this), 1)
    this.parentNode = null
  }
  replaceWith(...nodes) {
    const parent = this.parentNode
    const fresh = nodes.map((n) => (typeof n === 'string' ? new FakeText(n) : n))
    for (const n of fresh) n.parentNode = parent
    parent.children.splice(parent.children.indexOf(this), 1, ...fresh)
    this.parentNode = null
  }
}
class FakeText extends FakeNode {
  nodeType = 3
  constructor(data) {
    super()
    this.data = data
  }
  get textContent() {
    return this.data
  }
  get outerHTML() {
    return this.data.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  }
  cloneNode() {
    return new FakeText(this.data)
  }
}
const matchOne = (node, selector) => {
  const m = /^([a-z]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(selector)
  if (!m) throw Error(`selector not supported by the stand-in: ${selector}`)
  const [, tag, cls, attr] = m
  return (
    (!tag || node.tagName === tag.toUpperCase()) &&
    (!cls || (node.attrs.class || '').split(/\s+/).includes(cls)) &&
    (!attr || attr in node.attrs)
  )
}
class FakeElement extends FakeNode {
  nodeType = 1
  constructor(tag, attrs = {}, children = []) {
    super()
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.children = []
    this.append(...children)
  }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this.append(new FakeText(node))
      else if (node.nodeType === 11) this.append(...node.children.splice(0))
      else {
        node.parentNode = this
        this.children.push(node)
      }
    }
  }
  getAttribute(name) {
    return this.attrs[name] ?? null
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }
  get href() {
    return new URL(this.attrs.href, BASE).href
  }
  get src() {
    return new URL(this.attrs.src, BASE).href
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join('')
  }
  matches(selector) {
    return selector.split(',').some((s) => matchOne(this, s.trim()))
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node
    return null
  }
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children)
        if (child.nodeType === 1) {
          if (child.matches(selector)) found.push(child)
          walk(child)
        }
    }
    walk(this)
    return found
  }
  cloneNode(deep) {
    const copy = new FakeElement(this.tagName.toLowerCase(), this.attrs)
    if (deep) copy.append(...this.children.map((c) => c.cloneNode(true)))
    return copy
  }
  get innerHTML() {
    return this.children.map((c) => c.outerHTML).join('')
  }
  get outerHTML() {
    const tag = this.tagName.toLowerCase()
    const attrs = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join('')
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`
  }
}
class FakeFragment extends FakeElement {
  nodeType = 11
  constructor(children) {
    super('#fragment', {}, children)
  }
}
const el = (tag, attrs, ...children) => new FakeElement(tag, attrs || {}, children)
// The markup Price renders for 0.0000000412 (or other digits).
const tinyPrice = (digits = '412') =>
  el(
    'span',
    { class: 'price-tiny', title: `0.0000000${digits}` },
    '0.0',
    el('span', { class: 'price-zero-run' }, '000000'),
    el('sub', { class: 'price-zeros', 'data-zeros': '7', 'aria-hidden': 'true' }),
    digits,
  )
// A range over whole children of `ancestor` (from index `from` to `to`, inclusive).
const rangeOver = (ancestor, from = 0, to = ancestor.children.length - 1) => {
  const nodes = ancestor.children.slice(from, to + 1)
  const inside = new Set()
  const mark = (n) => {
    inside.add(n)
    n.children?.forEach(mark)
  }
  nodes.forEach(mark)
  return {
    commonAncestorContainer: ancestor,
    intersectsNode: (node) => inside.has(node),
    cloneContents: () => new FakeFragment(nodes.map((n) => n.cloneNode(true))),
  }
}
const fakeDoc = (ranges, text) => {
  const listeners = {}
  return {
    listeners,
    createElement: (tag) => new FakeElement(tag),
    getSelection: () => ({
      rangeCount: ranges.length,
      isCollapsed: ranges.length === 0,
      getRangeAt: (i) => ranges[i],
      toString: () => text,
      containsNode: (node) => ranges.some((r) => r.intersectsNode(node)),
    }),
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
  }
}
const clipboard = () => {
  const data = {}
  return { data, setData: (type, value) => (data[type] = value) }
}

test('a copy that includes a tiny price writes HTML with the zeros as ordinary text', () => {
  const value = el('span', { class: 'num' }, tinyPrice(), ' SOL')
  const range = rangeOver(value)
  assert.equal(touchesTinyPrice(range), true)
  const doc = fakeDoc([range], '0.0000000412 SOL')
  const out = clipboard()
  assert.equal(writeSelection(doc, out), true)
  assert.equal(out.data['text/plain'], '0.0000000412 SOL')
  // No zero run hidden by size and no empty count: the pasted text is the full decimal.
  assert.equal(
    out.data['text/html'],
    '<span class="price-tiny" title="0.0000000412">0.0000000412</span> SOL',
  )
  // The page itself is not changed.
  assert.equal(value.querySelectorAll('.price-zero-run').length, 1)
  assert.equal(value.querySelectorAll('.price-zeros').length, 1)
})

test('a copy inside one tiny price, or across table rows, still reads right when pasted', () => {
  // Selection within the price: the range's ancestor is the price itself.
  const price = tinyPrice()
  const inner = rangeOver(price)
  assert.equal(touchesTinyPrice(inner), true)
  assert.equal(selectedHtml(fakeDoc([]), inner), '0.0000000412')

  // Rows of the trades table keep their table, links get absolute URLs, and screen-reader-only
  // text (not visible on the page) stays out.
  const tbody = el(
    'tbody',
    null,
    el(
      'tr',
      null,
      el('td', null, 'buy'),
      el('td', null, el('a', { href: '/coin/abc' }, tinyPrice('413'))),
    ),
    el('tr', null, el('td', null, el('span', { class: 'sr-only' }, 'Side '), 'sell')),
  )
  el('table', { class: 'trades' }, tbody)
  assert.equal(
    selectedHtml(fakeDoc([]), rangeOver(tbody)),
    '<table class="trades"><tbody><tr><td>buy</td><td><a href="http://127.0.0.1:4350/coin/abc">' +
      '<span class="price-tiny" title="0.0000000413">0.0000000413</span></a></td></tr>' +
      '<tr><td>sell</td></tr></tbody></table>',
  )
})

test('copies without a tiny price are left to the browser', () => {
  const para = el('p', null, 'no price here', el('span', null, '0.05'))
  const out = clipboard()
  assert.equal(writeSelection(fakeDoc([rangeOver(para)], 'no price here0.05'), out), false)
  assert.deepEqual(out.data, {})
  // A collapsed selection, or no clipboard to write to, is never handled either.
  assert.equal(writeSelection(fakeDoc([], ''), clipboard()), false)
  const priced = rangeOver(el('span', null, tinyPrice()))
  assert.equal(writeSelection(fakeDoc([priced], 'x'), null), false)
  // A range next to a price that does not include it.
  const row = el('div', null, el('span', null, 'Price'), tinyPrice())
  assert.equal(touchesTinyPrice(rangeOver(row, 0, 0)), false)
})

test('the copy and drag handlers are installed once and stay out of text fields', () => {
  const value = el('span', { class: 'num' }, tinyPrice(), ' SOL')
  const doc = fakeDoc([rangeOver(value)], '0.0000000412 SOL')
  installPriceCopy(doc)
  installPriceCopy(doc)
  assert.equal(doc.listeners.copy.length, 1)
  assert.equal(doc.listeners.dragstart.length, 1)
  const [onCopy] = doc.listeners.copy
  const [onDrag] = doc.listeners.dragstart

  const copy = (target) => {
    const event = { target, clipboardData: clipboard(), defaultPrevented: false }
    event.preventDefault = () => (event.defaultPrevented = true)
    onCopy(event)
    return event
  }
  const fromPage = copy(value.children[0])
  assert.equal(fromPage.defaultPrevented, true)
  assert.match(fromPage.clipboardData.data['text/html'], /0\.0000000412<\/span> SOL$/)
  // A copy from a text field is the field's own.
  const field = copy(el('input', { value: 'abc' }))
  assert.equal(field.defaultPrevented, false)
  assert.deepEqual(field.clipboardData.data, {})

  // Dragging the selection carries the same flavors; dragging something outside it does not.
  const drag = (target) => {
    const event = { target, dataTransfer: clipboard() }
    onDrag(event)
    return event.dataTransfer.data
  }
  assert.equal(drag(value.children[0])['text/plain'], '0.0000000412 SOL')
  assert.deepEqual(drag(el('a', { href: '/x' }, 'link')), {})

  // Price installs it in the browser (an effect, so server rendering is unaffected).
  assert.match(source('src/components/Price.js'), /useEffect\(\(\) => installPriceCopy\(\), \[\]\)/)
  const lib = source('src/lib/priceCopy.js')
  assert.match(lib, /data\.setData\('text\/plain', selection\.toString\(\)\)/)
  assert.match(lib, /if \(writeSelection\(doc, event\.clipboardData\)\) event\.preventDefault\(\)/)
})

// ---------- K1: claims open at claimStart ----------

test('countdown rounds up and never reads as open early', () => {
  assert.equal(countdown(0), 'less than a minute')
  assert.equal(countdown(-5), 'less than a minute')
  assert.equal(countdown(59), 'less than a minute')
  assert.equal(countdown(60), '1 min')
  assert.equal(countdown(61), '2 min')
  assert.equal(countdown(3599), '1 h')
  assert.equal(countdown(3600), '1 h')
  assert.equal(countdown(5 * 3600 + 12 * 60 + 40), '5 h 13 min')
  assert.equal(countdown(6 * 3600), '6 h')
  assert.equal(countdown(86400), '1 d')
  assert.equal(countdown(7 * 86400 - 1), '7 d')
  assert.equal(countdown(86400 + 3601), '1 d 2 h')
})

test('claim timing: pending before claimStart, open after, expired at expiresAt', () => {
  const now = 1_800_000_000
  assert.deepEqual(claimTiming({ claimStart: now + 600, expiresAt: now + 86400 }, now), {
    state: 'pending',
    opensIn: 600,
  })
  assert.deepEqual(claimTiming({ claimStart: now, expiresAt: now + 86400 }, now), {
    state: 'open',
  })
  assert.deepEqual(claimTiming({ claimStart: now - 1 }, now), { state: 'open' })
  assert.deepEqual(claimTiming({ claimStart: now - 9, expiresAt: now }, now), {
    state: 'expired',
  })
  // Records from before the claim delay carry no claimStart (or null): open at once.
  assert.deepEqual(claimTiming({ expiresAt: now + 1 }, now), { state: 'open' })
  assert.deepEqual(claimTiming({ claimStart: null }, now), { state: 'open' })
})

test('upcoming epochs: posted, not cancelled or closed, claims not offered yet; soonest first', () => {
  const now = 1_800_000_000
  const epochs = [
    { index: 4, total: '2000000000', holders: 9, claimStart: now + 7200, expiresAt: now + 9e5 },
    { index: 3, total: '1000000000', holders: 1, claimStart: now + 60, expiresAt: now + 9e5 },
    { index: 2, total: '5', claimStart: now + 60, cancelled: true, closed: true },
    { index: 1, total: '5', claimStart: now - 3600, expiresAt: now + 9e5 },
    { index: 0, total: '5', claimStart: null, expiresAt: now + 9e5 },
    // Opened a moment ago: still "opening" until the keeper offers it (OPEN_SLACK).
    { index: 5, total: '5', claimStart: now - 10, expiresAt: now + 9e5 },
    null,
  ]
  assert.deepEqual(
    upcomingEpochs(epochs, now).map((e) => e.index),
    [5, 3, 4],
  )
  assert.deepEqual(upcomingEpochs(undefined, now), [])
  assert.equal(nextRefresh(upcomingEpochs(epochs, now), now), now - 10 + OPEN_SLACK)
  assert.equal(nextRefresh([{ claimStart: now - OPEN_SLACK }], now), null)
  assert.equal(nextRefresh([], now), null)
  // The keeper offers a claim 30 s after claimStart; the page re-reads after that.
  assert.ok(OPEN_SLACK > 30)
})

test('a claim whose epoch has not opened shows when it opens and no Claim button', () => {
  const now = 1_800_000_000
  const claimed = []
  const props = {
    now,
    busy: '',
    onClaim: (c) => claimed.push(c),
    upcoming: [
      { index: 6, total: '1500000000', holders: 12, claimStart: now + 5 * 3600 + 30 * 60 },
    ],
    items: [
      {
        index: 5,
        leafIndex: 0,
        amount: '250000000',
        proof: [],
        claimStart: now + 3600,
        expiresAt: now + 30 * 86400,
      },
    ],
  }
  const html = render(ui.EntanglementClaims, props)
  assert.doesNotMatch(html, /<button/)
  assert.match(text(html), /Epoch 7: 1\.5 SOL for 12 holders/)
  assert.match(text(html), /Claims open in 5 h 30 min/)
  assert.match(text(html), /0\.25 SOL.*epoch 6.*Claims open in 1 h/)
  assert.match(text(html), /Quant Pad can cancel the epoch/)

  // Once open, the same claim gets its button.
  const open = render(ui.EntanglementClaims, { ...props, upcoming: [], now: now + 3600 })
  assert.equal(open.match(/<button/g)?.length, 1)
  assert.match(text(open), /Claim$/)
  assert.doesNotMatch(text(open), /Claims open in/)
  // Nothing to show: nothing rendered.
  assert.equal(render(ui.EntanglementClaims, { now, upcoming: [], items: [] }), '')
})

test('the Quantum panel takes its claims through EntanglementClaims and re-reads them on opening', () => {
  const panel = source('src/components/QuantumPanel.jsx')
  assert.match(panel, /<EntanglementClaims/)
  assert.match(panel, /upcomingEpochs\(history\.data\?\.epochs, now\)/)
  assert.match(panel, /nextRefresh\(/)
  assert.match(panel, /'cancel-epoch': 'Epoch cancelled'/)
  // The only Claim button lives in EntanglementClaims, behind the open check.
  assert.doesNotMatch(panel, />\s*Claim\s*</)
})

test('a claim the program refuses as not open yet gets a plain message', () => {
  registerQuantumIdl({
    address: PROGRAMS.quantum,
    errors: [{ code: 6045, name: 'ClaimNotOpen', msg: 'Claims for this epoch are not open yet' }],
  })
  assert.match(explainCustomError(PROGRAMS.quantum, 6045), /not open yet\. Try again when/)
})

// ---------- fullstack-defect-2: the fee shown is the fee charged ----------

test('the charged platform fee follows the transfer rule', () => {
  const platform = { treasury: Keypair.generate().publicKey.toBase58(), feeBps: 50 }
  const small = 100_000_000n // 0.1 SOL → 500 000 lamports, below the rent-exempt minimum
  const large = 500_000_000n // 0.5 SOL → 2 500 000 lamports
  assert.equal(chargedPlatformFee(platform, small, 0n), 0n)
  assert.equal(chargedPlatformFee(platform, small, null), 0n)
  assert.equal(chargedPlatformFee(platform, small, 400_000n), 500_000n)
  assert.equal(chargedPlatformFee(platform, small, RENT_EXEMPT_MINIMUM), 500_000n)
  assert.equal(chargedPlatformFee(platform, large, 0n), 2_500_000n)
  assert.equal(chargedPlatformFee(platform, large, null), 2_500_000n)
  assert.equal(chargedPlatformFee({ treasury: null, feeBps: 50 }, large, 0n), 0n)
  assert.equal(chargedPlatformFee({ ...platform, feeBps: 0 }, large, 0n), 0n)
  assert.equal(chargedPlatformFee(platform, 0n, 0n), 0n)
  assert.equal(chargedPlatformFee(platform, null, 0n), 0n)
  assert.equal(chargedPlatformFee(null, large, 0n), 0n)
})

test('the summary rule and the built transfer agree for every treasury state', async () => {
  const user = Keypair.generate().publicKey.toBase58()
  let balanceOf = () => 0
  solana.connection.getBalance = async () => {
    const value = balanceOf()
    if (value instanceof Error) throw value
    return value
  }
  const amounts = [0n, 1n, 10_000n, 100_000_000n, 178_000_000n, 178_176_000n, 500_000_000n]
  const balances = [0, 1, 400_000, 890_879, 890_880, 5_000_000, Error('502')]
  for (const lamports of amounts)
    for (const balance of balances)
      for (const feeBps of [0, 50, 100]) {
        // A fresh treasury each time: a funded one is remembered.
        const platform = { treasury: Keypair.generate().publicKey.toBase58(), feeBps }
        balanceOf = () => balance
        const shown = chargedPlatformFee(
          platform,
          lamports,
          balance instanceof Error ? null : BigInt(balance),
        )
        const charged = await solana.platformFeeCharged(platform, lamports)
        const transfer = await solana.platformFeeInstruction(user, platform, lamports)
        const label = `${lamports} lamports, balance ${balance}, ${feeBps} bps`
        assert.equal(charged, shown, label)
        assert.equal(transfer ? 1 : 0, shown > 0n ? 1 : 0, label)
        if (shown > 0n) assert.equal(shown, platformFee(lamports, feeBps), label)
      }
})

test('the launch summary and the trade ticket show the charged fee, not the nominal one', () => {
  const launch = source('src/pages/LaunchPage.jsx')
  assert.match(launch, /const feeCharged = useChargedPlatformFee\(platform, devLamports \|\| 0n\)/)
  const summary = launch.slice(launch.indexOf('summary-costs'))
  assert.match(summary, /\{feeCharged > 0n && \(/)
  assert.match(summary, /sol\(toSol\(feeCharged\)\)/)
  assert.doesNotMatch(summary.slice(0, summary.indexOf('</dl>')), /\{fee > 0n/)
  const ticket = source('src/components/TradeTicket.jsx')
  assert.match(ticket, /const fee = useChargedPlatformFee\(/)
  const hook = source('src/lib/useChargedFee.js')
  assert.match(hook, /chargedPlatformFee\(/)
  assert.match(hook, /treasuryBalance\(treasury\)/)
})

// ---------- build-defect-6 / 7: ids, labels and landmarks ----------

test('each copy of the site search has its own id, label and landmark name', () => {
  const html = render(
    ui.MemoryRouter,
    null,
    ui.createElement(ui.SearchBox),
    ui.createElement(ui.SearchBox),
  )
  const ids = [...html.matchAll(/<input[^>]* id="([^"]+)"/g)].map((m) => m[1])
  const fors = [...html.matchAll(/<label[^>]* for="([^"]+)"/g)].map((m) => m[1])
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual(fors, ids)
  assert.ok(!ids.includes('global-search'))
  assert.equal(html.match(/role="search" aria-label="Site search"/g)?.length, 2)
  assert.match(source('src/components/Shell.jsx'), /import SearchBox from '\.\/SearchBox\.jsx'/)
  // The market's own search is a separately named landmark.
  assert.match(source('src/pages/MarketPage.jsx'), /role="search"\s+aria-label="Search the market"/)
})

test('the tape is a labelled region, so no page content sits outside a landmark', () => {
  const tape = source('src/components/Tape.jsx')
  assert.match(tape, /<section className="tape" aria-label="Trending coins">/)
  assert.doesNotMatch(tape, /<div className="tape"/)
})

test('coin page headings run h1 → h2 panels → h3 sub-headings', () => {
  const chart = source('src/components/MarketChart.jsx')
  assert.doesNotMatch(chart, /<h[1-6]/)
  assert.match(chart, /<p className="chart-empty-title">/)
  assert.match(source('src/components/TradesTable.jsx'), /<h2 id="trades-title" className="h3">/)
  assert.match(source('src/pages/CoinPage.jsx'), /<h2 className="h3">About<\/h2>/)
  const panel = source('src/components/QuantumPanel.jsx')
  assert.doesNotMatch(panel, /<h4|<h3>Quantum Hooks/)
  assert.equal(panel.match(/<h2[^>]*className="h3"/g)?.length, 3)
  assert.doesNotMatch(source('src/components/EntanglementClaims.jsx'), /<h[124]/)
  // The h3 look survives the change of level.
  assert.match(source('src/styles/base.css'), /h3,\s*\.h3\s*{/)
  assert.match(source('src/styles/components.css'), /\.panel-head h3,\s*\.panel-head \.h3\s*{/)
  assert.match(source('src/styles/pages.css'), /\.quantum-block h3\s*{[^}]*font-stretch:\s*112%/)
  assert.match(
    source('src/styles/pages.css'),
    /\.chart-empty-title\s*{[^}]*font-size: var\(--t-md\)/,
  )
})

test('empty states take the heading level of where they appear', () => {
  const ui2 = source('src/components/UI.jsx')
  assert.match(ui2, /export function Empty\(\{ title, children, action, level = 2 \}\)/)
  assert.match(ui2, /<Heading className="h3 empty-title">/)
  assert.match(source('src/pages/HomePage.jsx'), /<Empty\s+level=\{3\}/)
  assert.match(source('src/pages/PortfolioPage.jsx'), /<Empty\s+level=\{1\}/)
  assert.doesNotMatch(source('src/styles/components.css'), /\.empty h3/)
})

// ---------- cross: coins that migrated off pump.fun (indexer poolMissing) ----------

// TradeTicket and CurveProgress, with the wallet and platform contexts replaced by plain values
// and the lazily loaded trade module left out (it is only loaded in an effect).
const ticketUi = await loadJsx(
  `
  export { renderToStaticMarkup } from 'react-dom/server'
  export { createElement } from 'react'
  export { default as TradeTicket } from './src/components/TradeTicket.jsx'
  export { CurveProgress } from './src/components/UI.jsx'
`,
  [
    {
      name: 'stub-contexts',
      setup(b) {
        b.onResolve({ filter: /(WalletContext|PlatformContext)\.jsx$|\/trade\.js$/ }, (args) => ({
          path: args.path,
          namespace: 'stub',
        }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          loader: 'js',
          contents: args.path.includes('Wallet')
            ? 'export const useWallet = () => globalThis.__qpWallet'
            : args.path.includes('Platform')
              ? 'export const usePlatform = () => globalThis.__qpPlatform'
              : 'export {}',
        }))
      },
    },
  ],
)
const renderTicket = (coin, { connected }) => {
  globalThis.__qpWallet = {
    connected,
    address: connected ? Keypair.generate().publicKey.toBase58() : null,
    balance: connected ? 2_000_000_000n : null,
    openDialog: () => {},
    sendTransactions: async () => [],
  }
  globalThis.__qpPlatform = { platform: { feeBps: 0, treasury: null }, lookupTable: null }
  return ticketUi.renderToStaticMarkup(ticketUi.createElement(ticketUi.TradeTicket, { coin }))
}

test('a coin with no PumpSwap pool closes the trade ticket with the reason', () => {
  const coin = { mint: Keypair.generate().publicKey.toBase58(), symbol: 'ECAT', complete: true }
  for (const connected of [false, true]) {
    const html = renderTicket({ ...coin, poolMissing: true }, { connected })
    const submit = /<button type="submit"[^>]*>(.*?)<\/button>/.exec(html)
    assert.match(submit[0], /disabled=""/, `connected: ${connected}`)
    assert.equal(submit[1], 'Migrated off pump.fun')
    assert.match(html, /<input id="ticket-amount"[^>]*disabled=""/)
    assert.match(html, /aria-describedby="ticket-migrated"/)
    assert.match(text(html), /Migrated off pump\.fun\. This coin graduated before PumpSwap/)
    // No market read is waited on or retried: no spinner, no "Could not read" message.
    assert.doesNotMatch(html, /class="spinner"/)
    assert.doesNotMatch(html, /Could not read/)
    // The SOL presets cannot fill in an amount either.
    for (const preset of html.match(/<button type="button" class="btn btn-sm"[^>]*>/g) || [])
      assert.match(preset, /disabled=""/)
  }
  // A coin that still has a market keeps the ordinary ticket (waiting for the market read).
  const open = renderTicket({ ...coin, complete: false, poolMissing: false }, { connected: true })
  assert.match(open, /<button type="submit"[^>]*>Buy ECAT<\/button>/)
  assert.doesNotMatch(open, /Migrated off pump\.fun/)
  assert.match(open, /class="spinner"/)

  const ticket = source('src/components/TradeTicket.jsx')
  // The market poll does not run at all for such a coin.
  assert.match(ticket, /useEffect\(\(\) => \{\s*if \(migrated\) return\s*refresh\(\)/)
  assert.match(ticket, /e\.preventDefault\(\)\s*if \(migrated\) return/)
})

test('graduated coins without a pool read "Migrated off pump.fun", not "Graduated to PumpSwap"', () => {
  const curve = (props) =>
    text(ticketUi.renderToStaticMarkup(ticketUi.createElement(ticketUi.CurveProgress, props)))
  assert.match(curve({ progress: 100, complete: true, migrated: true }), /^Migrated off pump\.fun/)
  assert.match(curve({ progress: 100, complete: true }), /^Graduated to PumpSwap/)
  assert.match(curve({ progress: 40, complete: false, migrated: true }), /^Bonding curve/)

  const page = source('src/pages/CoinPage.jsx')
  assert.match(page, /c\.poolMissing\s*\?\s*'Migrated off pump\.fun'\s*:\s*'Graduated to PumpSwap'/)
  assert.match(page, /migrated=\{!!c\.poolMissing\}/)
  const list = source('src/components/CoinList.jsx')
  assert.match(list, /migrated=\{!!coin\.poolMissing\}/)
  assert.match(list, /migrated=\{!!c\.poolMissing\}/)
})

test('the Quantum panel shows amounts owed to wallets below the rent minimum', () => {
  const panel = source('src/components/QuantumPanel.jsx')
  assert.match(
    panel,
    /q\.splitOwed\?\.\[i\] > 0n && ` · \$\{sol\(toSol\(q\.splitOwed\[i\]\)\)\} owed`/,
  )
  assert.match(panel, /q\.launcherOwed > 0n && \(\s*<>\s*<dt>Owed to creator<\/dt>/)
  assert.match(panel, /at least 0\.00089 SOL pays its amount in full/)
})
