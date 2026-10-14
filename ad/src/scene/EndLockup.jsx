// Shot 6: the full lockup in 3D. The Q drops in on the final hit; the QUANT PAD letters resolve
// one by one beside it. Built from the lockup SVG's own placement.
import { useMemo } from 'react'
import * as THREE from 'three'
import { useCurrentFrame } from 'remotion'
import { FPS, CUES } from '../timeline.js'
import { prog, ease } from '../anim.js'
import { END } from './layout.js'
import { markGeometry, wordmarkGeometry, LOCKUP, COUNTER } from './logoGeometry.js'
import { blackChrome, cobalt } from './materials.js'

const K = 0.0084 // lockup units → world

export function EndLockup() {
  const t = useCurrentFrame() / FPS
  const mark = useMemo(markGeometry, [])
  const word = useMemo(wordmarkGeometry, [])
  const letterMats = useMemo(
    () => word.letters.map(() => Object.assign(blackChrome.clone(), { transparent: true })),
    [word],
  )
  const tailMat = useMemo(() => Object.assign(cobalt.clone(), { transparent: true }), [])
  if (t < 25.3) return null

  // Q: falls for the five frames before the hit, lands on it, settles
  const fall = ease.in(prog(t, CUES.final - 5 / FPS, CUES.final))
  const settle = t > CUES.final ? 14 * Math.sin(prog(t, CUES.final, CUES.final + 0.3) * Math.PI) * Math.exp(-(t - CUES.final) * 6) : 0
  const markY = (1 - fall) * 700 + settle

  const ms = LOCKUP.markScale
  const w = LOCKUP.word
  const letter = (i) => ease.out(prog(t, CUES.final + 0.45 + i * 0.06, CUES.final + 0.85 + i * 0.06))

  return (
    <group position={END} scale={K}>
      <group position={[-LOCKUP.width / 2, LOCKUP.height / 2, 0]}>
        <group position={[COUNTER[0] * ms, COUNTER[1] * ms + markY, 0]} scale={ms}>
          <mesh geometry={mark.body} material={blackChrome} />
          <mesh geometry={mark.tail} material={cobalt} position-z={4} />
        </group>
        <group position={[w.x, -w.y, 0]} scale={w.scale}>
          {word.letters.map((g, i) => {
            const k = letter(i)
            letterMats[i].opacity = k
            return (
              <mesh key={i} geometry={g} material={letterMats[i]} position={[0, -12 * (1 - k), -90 * (1 - k)]} visible={k > 0} />
            )
          })}
          {(() => {
            const k = letter(0)
            tailMat.opacity = k
            return <mesh geometry={word.tail} material={tailMat} position={[0, -12 * (1 - k), 2 - 90 * (1 - k)]} visible={k > 0} />
          })()}
        </group>
      </group>
    </group>
  )
}
