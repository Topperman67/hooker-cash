// Where the hero Refractor's light runs, in stage pixels: the white fee beam from the source pill
// into the Q, and the four hook lines from its tail to the readout cards. The static SVG fallback
// and the live WebGL scene both draw these routes, measured from the DOM, so CSS alone decides the
// layout at every width and the scene fading in never moves anything. Free of three.js: the main
// bundle imports it.

/** Points on the mark, as fractions of its 512-unit box (public/brand/mark.svg). */
export const MARK = {
  counter: [236 / 512, 232 / 512],
  // middle of the tail's outer edge, where the four lines leave
  exit: [460.86 / 512, 456.86 / 512],
  // where the up-left diagonal through the counter meets the outer edge
  entry: [62.8 / 512, 58.8 / 512],
}

/** The example split the hero shows (the launch default, "Balanced"). */
export const EXAMPLE = { creatorBps: 3000, burnBps: 3000, entangleBps: 2000, fusionBps: 2000 }

/**
 * One fee pulse, in seconds. The white pulse leaves the source pill at 0, hits the glass at
 * `enter`, crosses the Q and leaves the tail at `exit`; the four hook pulses follow `spread` apart
 * and take `travel` to reach their readouts. The loop repeats every LOOP seconds.
 */
export const LOOP = 7.2
export const T = { enter: 0.85, exit: 1.65, spread: 0.09, travel: 0.8 }
export const arrival = (i) => T.exit + i * T.spread + T.travel

const OUT = [Math.SQRT1_2, Math.SQRT1_2] // down the tail, away from the counter (screen, y down)
const ALONG = [Math.SQRT1_2, -Math.SQRT1_2] // along the tail's outer edge, towards its upper corner
const ENTER = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] }

const centre = (el, box) => {
  const r = el.getBoundingClientRect()
  return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2]
}

/**
 * Reads the stage: its size, the mark's box (.refractor-q), the source node and each readout's
 * node with the direction its line arrives in (the node's --enter: down, up, left or right) and
 * how far it may swing out first (--reach, px).
 */
export function measure(stage) {
  const box = stage.getBoundingClientRect()
  const q = stage.querySelector('.refractor-q').getBoundingClientRect()
  const feed = stage.querySelector('.feed-node')
  return {
    w: box.width,
    h: box.height,
    q: { x: q.left - box.left, y: q.top - box.top, size: q.width },
    feed: feed ? centre(feed, box) : [0, 0],
    outs: [...stage.querySelectorAll('.readout-node')].map((node) => {
      const css = getComputedStyle(node)
      return {
        at: centre(node, box),
        enter: css.getPropertyValue('--enter').trim() || 'down',
        // how far the line may swing out before it turns in (a gutter's width, say)
        reach: parseFloat(css.getPropertyValue('--reach')) || null,
      }
    }),
  }
}

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k]
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** A point on the mark, in stage pixels. */
export const markPoint = (q, [fx, fy]) => [q.x + fx * q.size, q.y + fy * q.size]

/**
 * Slot order along the tail edge, so lines leaving it never cross: the line heading furthest
 * clockwise (towards the bottom left) takes the lowest slot. Returns each readout's slot, -1.5..1.5.
 */
export function slots(exit, outs) {
  const angle = (o) => Math.atan2(o.at[1] - exit[1], o.at[0] - exit[0])
  const order = outs.map((o, i) => [angle(o), i]).sort((a, b) => b[0] - a[0])
  const slot = []
  order.forEach(([, i], rank) => (slot[i] = rank - (outs.length - 1) / 2))
  return slot
}

/**
 * The cubic Bézier for one hook line. It leaves the tail edge at `slot` and disperses like light
 * leaving a prism, each line turned part way towards its readout, then bends into the readout from
 * the --enter direction. All in pixels; `size` is the mark box.
 */
export function hookCurve(exit, slot, out, size) {
  const start = add(add(exit, ALONG, slot * size * 0.028), OUT, -size * 0.035)
  const end = out.at
  const into = ENTER[out.enter] || ENTER.down
  const d = dist(start, end)
  const aim = [(end[0] - start[0]) / d, (end[1] - start[1]) / d]
  const fan = [OUT[0] * 0.45 + aim[0] * 0.55, OUT[1] * 0.45 + aim[1] * 0.55]
  const k = Math.hypot(fan[0], fan[1])
  const lead = Math.min(d * 0.4, size * 0.32)
  const reach = Math.min(d * 0.45, out.reach ?? Infinity)
  return [start, add(start, [fan[0] / k, fan[1] / k], lead), add(end, into, -reach), end]
}

/**
 * The fee beam in two pieces: `inbound`, nearly straight from the source node to just outside the
 * glass on the up-left diagonal, and `through`, along the diagonal to the tail. The kink where they
 * meet is the beam refracting as it enters.
 */
export function beamCurves(feed, entry, exit, size) {
  const outside = add(entry, OUT, -size * 0.04)
  const d = dist(feed, outside)
  const inbound = [
    feed,
    add(feed, [0, 1], d / 3),
    add(outside, [(feed[0] - outside[0]) / d, (feed[1] - outside[1]) / d], d / 3),
    outside,
  ]
  const end = add(exit, OUT, -size * 0.04)
  const third = dist(outside, end) / 3
  const through = [outside, add(outside, OUT, third), add(end, OUT, -third), end]
  return { inbound, through }
}

/** Every route at rest (the mark untilted), for the SVG fallback. */
export function routes(L) {
  const exit = markPoint(L.q, MARK.exit)
  const entry = markPoint(L.q, MARK.entry)
  const slot = slots(exit, L.outs)
  return {
    ...beamCurves(L.feed, entry, exit, L.q.size),
    hooks: L.outs.map((o, i) => hookCurve(exit, slot[i], o, L.q.size)),
  }
}

/** SVG path data for a cubic. */
export const pathData = ([a, b, c, d]) =>
  `M${a[0].toFixed(1)} ${a[1].toFixed(1)}C${b[0].toFixed(1)} ${b[1].toFixed(1)} ${c[0].toFixed(1)} ${c[1].toFixed(1)} ${d[0].toFixed(1)} ${d[1].toFixed(1)}`
