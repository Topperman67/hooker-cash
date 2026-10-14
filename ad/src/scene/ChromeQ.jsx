import { useMemo } from 'react'
import { markGeometry } from './logoGeometry.js'
import { chrome, cobalt } from './materials.js'
import { MARK_SCALE } from './layout.js'

/** The Q-Pad mark in 3D: chrome body, cobalt tail, counter centred on the group's origin. */
export function Mark({ bodyMaterial = chrome, tailMaterial = cobalt, ...props }) {
  const { body, tail } = useMemo(markGeometry, [])
  return (
    <group {...props}>
      <group scale={MARK_SCALE}>
        <mesh geometry={body} material={bodyMaterial} />
        <mesh geometry={tail} material={tailMaterial} position-z={4} />
      </group>
    </group>
  )
}
