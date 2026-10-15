// The card's HTML, moved by the live scene: chart labels follow their 3D anchors, the step chips
// light in time with the loop, and the 60% / 40% rows pulse when their stream lands. Everything
// is written straight to the DOM (no React state per frame) and only when it changes; reset()
// hands the card back to its static look.
import { STEPS } from './flywheelTimeline.js'

const canAnimate = (el) => typeof el?.animate === 'function'

export function createHud(dom) {
  const steps = [...(dom.loop.current?.children ?? [])]
  const lit = steps.map(() => false)
  const labels = { fee: dom.fee.current, burn: dom.burn.current, holders: dom.holders.current }
  const shown = new Map()
  const running = new Set()

  const play = (el, keyframes, options) => {
    if (!canAnimate(el)) return
    const a = el.animate(keyframes, options)
    running.add(a)
    a.onfinish = a.oncancel = () => running.delete(a)
  }

  return {
    labels,

    /** Moves a label by (x, y) px from its static place; opacity null leaves the CSS value. */
    place(el, x, y, opacity = null) {
      if (!el) return
      el.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`
      const o = opacity === null ? '' : opacity.toFixed(3)
      if (shown.get(el) !== o) {
        el.style.opacity = o
        shown.set(el, o)
      }
    },

    /** Lights the chips whose window holds tau (tau < 0: none). */
    steps(tau) {
      steps.forEach((el, i) => {
        const [a, b] = STEPS[i] ?? [0, 0]
        const on = tau >= a && tau < b
        if (on !== lit[i]) {
          lit[i] = on
          el.classList.toggle('is-on', on)
        }
      })
    },

    /** One-shot pulses on the beats. */
    beat(name) {
      if (name === 'fee') {
        play(labels.fee?.querySelector('b'), [{ scale: 1 }, { scale: 1.07 }, { scale: 1 }], {
          duration: 900,
          easing: 'cubic-bezier(.2,.7,.2,1)',
        })
        play(
          labels.fee?.querySelector('.fw-fee-glow'),
          [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }],
          {
            duration: 1300,
            easing: 'ease-out',
          },
        )
      } else if (name === 'holders' || name === 'burn') {
        const row = (name === 'holders' ? dom.rowHolders : dom.rowBurn).current
        play(
          row?.querySelector('.fw-row-glow'),
          [{ opacity: 0 }, { opacity: 1, offset: 0.18 }, { opacity: 0 }],
          {
            duration: 1700,
            easing: 'ease-out',
          },
        )
        play(
          row?.querySelector('.fw-pct'),
          [{ scale: 1 }, { scale: 1.08, offset: 0.2 }, { scale: 1 }],
          {
            duration: 900,
            easing: 'cubic-bezier(.2,.7,.2,1)',
          },
        )
      } else if (name === 'holders-chip' || name === 'burn-chip') {
        const el = name === 'holders-chip' ? labels.holders : labels.burn
        play(el, [{ scale: 1 }, { scale: 1.09, offset: 0.25 }, { scale: 1 }], {
          duration: 800,
          easing: 'cubic-bezier(.2,.7,.2,1)',
        })
      }
    },

    reset() {
      for (const a of running) a.cancel()
      running.clear()
      for (const el of Object.values(labels)) {
        if (!el) continue
        el.style.translate = ''
        el.style.opacity = ''
      }
      shown.clear()
      steps.forEach((el, i) => {
        lit[i] = false
        el.classList.remove('is-on')
      })
    },
  }
}
