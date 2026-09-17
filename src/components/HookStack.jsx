import { useEffect, useRef } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import Glass from './Glass'
import { BrandMark, Logo } from './UI'
import './hook-stack.css'

const layers = [
  { id: 'pool', title: 'Uniswap V4', detail: 'The pool', mark: <BrandMark name="uniswap" /> },
  { id: 'hook', title: 'Your hook', detail: 'Your rules', mark: <Logo compact /> },
  {
    id: 'swap',
    title: 'Every swap',
    detail: 'On-chain execution',
    mark: <ArrowLeftRight size={27} strokeWidth={1.4} />,
  },
]

export default function HookStack() {
  const stage = useRef(null)
  const frame = useRef(0)
  const motionAllowed = useRef(false)

  function reset() {
    cancelAnimationFrame(frame.current)
    if (!stage.current) return
    stage.current.dataset.active = 'false'
    for (const [name, value] of [
      ['--tilt-x', '0deg'],
      ['--tilt-y', '0deg'],
      ['--drift-x', '0px'],
      ['--drift-y', '0px'],
      ['--light-x', '50%'],
      ['--light-y', '30%'],
    ]) {
      stage.current.style.setProperty(name, value)
    }
  }

  useEffect(() => {
    const preference = matchMedia(
      '(prefers-reduced-motion: no-preference) and (hover: hover) and (pointer: fine)',
    )
    const update = () => {
      motionAllowed.current = preference.matches
      if (!preference.matches) reset()
    }
    update()
    preference.addEventListener('change', update)
    return () => {
      cancelAnimationFrame(frame.current)
      preference.removeEventListener('change', update)
    }
  }, [])

  function move(event) {
    if (!motionAllowed.current || event.pointerType !== 'mouse') return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1))
    const y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1))
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const element = stage.current
      if (!element) return
      element.dataset.active = 'true'
      element.style.setProperty('--tilt-x', `${-y * 9}deg`)
      element.style.setProperty('--tilt-y', `${x * 10}deg`)
      element.style.setProperty('--drift-x', `${x * 9}px`)
      element.style.setProperty('--drift-y', `${y * 5}px`)
      element.style.setProperty('--light-x', `${50 + x * 30}%`)
      element.style.setProperty('--light-y', `${35 + y * 25}%`)
    })
  }

  return (
    <figure
      ref={stage}
      className="hook-stack"
      onPointerMove={move}
      onPointerLeave={reset}
      onPointerCancel={reset}
      aria-label="Launch architecture illustration: each swap passes through your hook to a Uniswap V4 pool."
    >
      <div className="hook-stack-halo" aria-hidden="true" />
      <div className="hook-stack-scene">
        {layers.map(({ id, title, detail, mark }) => (
          <div className={`hook-layer hook-layer-${id}`} key={id}>
            <Glass variant="clear" tone="violet" radius={30} className="hook-layer-glass">
              <div className="hook-layer-top">
                {mark}
                <span>{detail}</span>
              </div>
              <span className="hook-layer-title">{title}</span>
              <span className="hook-layer-edge" aria-hidden="true" />
            </Glass>
          </div>
        ))}
      </div>
      <figcaption>
        <span />
        One launch. Three layers of possibility.
      </figcaption>
    </figure>
  )
}
