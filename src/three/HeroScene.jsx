// The hero Refractor, live: the Q in clear liquid glass with its cobalt glass tail, the four hook
// lines raking behind it, glass droplets around it, and the fee story on a loop. A white pulse
// runs down the beam into the glass, the glass rings and jiggles where it lands, four coloured
// pulses leave the tail, and each readout flashes as its pulse arrives (Refractor.jsx owns the
// readouts; this sets their data-hit). Loaded on demand only where WebGL works.
//
// Rendering is done here rather than by R3F: one pass draws everything behind the glass into a
// buffer, a second adds the Q's back faces, and the main pass draws the glass sampling those. Every
// glass piece shares the two buffers, so the cost stays two extra scene renders a frame, not one
// or two per piece.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { glassMarkGeometry, TAIL_EXIT } from './logoGeometry.js'
import { LINES } from './kit.jsx'
import HeroStudio from './heroStudio.jsx'
import { LiquidGlassMaterial } from './heroGlass.js'
import { poolMaterial, rayGeometry, rayMaterial } from './heroRay.js'
import { LOOP, MARK, T, arrival, beamCurves, hookCurve, markPoint, slots } from './heroLayout.js'

const FOV = 30
const DISTANCE = 16
// what the glass sees behind it where the scene has nothing: the page's studio at the hero
const PAGE = { light: '#f5f6f8', dark: '#07080c' }
// quality tiers, stepped down by the performance monitor: pixel ratio and buffer size. The back
// faces stay at every tier: without them clear glass on a light page reads as white plastic.
const TIERS = [
  { dpr: 1, buffer: 512 },
  { dpr: 1.25, buffer: 768 },
  { dpr: 1.75, buffer: 1024 },
]
// a calm moment of the loop, for reduced motion
const STILL = 3.9

// The mark's own frame (SVG units, y up, counter at the origin).
const OUT = new THREE.Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0)
const local = ([fx, fy]) =>
  new THREE.Vector3((fx - MARK.counter[0]) * 512, (MARK.counter[1] - fy) * 512, 0)
const SURFACE = local(MARK.entry)
const ENTRY = SURFACE.clone().addScaledVector(OUT, -0.04 * 512)
const EXIT = new THREE.Vector3(TAIL_EXIT[0], TAIL_EXIT[1], 0).addScaledVector(OUT, -0.04 * 512)

// Glass droplets around the Q: offsets from the counter in mark boxes, depth in world units.
const DROPS = [
  { at: [-0.36, 0.62], z: 1.2, size: 0.046, rot: [0, 0, 0] },
  { at: [0.58, -0.56], z: 0.5, size: 0.026, rot: [0, 0, 0] },
  { at: [0.2, 0.7], z: 0.7, size: 0.02, rot: [0, 0, 0] },
  { at: [0.12, -0.84], z: -1.2, size: 0.018, rot: [0, 0, 0] },
  { at: [1.02, -0.3], z: -1, size: 0.03, rot: [0.3, 0.2, -0.75], pill: true },
  { at: [-0.36, 0.44], z: 0.9, size: 0.018, rot: [0.4, 0.3, 0.9], pill: true },
]

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
const since = (ph, at) => (ph >= at ? ph - at : ph + LOOP - at)

export default function HeroScene({ stage, layout, active, still, theme, onReady, onLost }) {
  const wrap = useRef(null)
  const [tier, setTier] = useState(2)
  const q = TIERS[tier]
  const dpr = Math.min(window.devicePixelRatio || 1, q.dpr)
  return (
    <div ref={wrap} className="refractor-scene" aria-hidden="true">
      <Canvas
        dpr={dpr}
        frameloop={still ? 'demand' : active ? 'always' : 'never'}
        gl={{ antialias: true, alpha: true, stencil: false, powerPreference: 'high-performance' }}
        camera={{ fov: FOV, near: 0.1, far: 60, position: [0, 0, DISTANCE] }}
        onCreated={({ gl }) => {
          // no tone mapping: what the glass shows must match the page around it exactly
          gl.toneMapping = THREE.NoToneMapping
          gl.setClearColor(0x000000, 0)
          // a lost GPU context leaves a blank canvas over the hidden fallback: hand back to it
          gl.domElement.addEventListener('webglcontextlost', () => onLost?.(), { once: true })
        }}
      >
        {!still && (
          <PerformanceMonitor
            flipflops={3}
            onDecline={() => setTier((t) => Math.max(0, t - 1))}
            onIncline={() => setTier((t) => Math.min(TIERS.length - 1, t + 1))}
            onFallback={() => setTier(0)}
          />
        )}
        <Scene
          wrap={wrap}
          stage={stage}
          layout={layout}
          still={still}
          dark={theme === 'dark'}
          quality={q}
          onReady={onReady}
        />
      </Canvas>
    </div>
  )
}

function Scene({ wrap, stage, layout, still, dark, quality, onReady }) {
  const { gl, scene, camera, size, invalidate } = useThree()
  const pointer = useRef({ x: 0, y: 0, tx: 0, ty: 0 })
  const clock = useRef({ t: 0, ph: 0, frames: 0 })
  const refs = useRef({ drops: [] })

  // ---- things to draw -------------------------------------------------------------------------
  const mark = useMemo(() => glassMarkGeometry({ depth: 70, bevel: 34, segments: 16 }), [])
  const glass = useMemo(() => {
    const clear = {
      loop: LOOP,
      ior: 1.5,
      roughness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0,
      color: '#ffffff',
      attenuationColor: '#e6ecff',
      attenuationDistance: 2.4,
    }
    return {
      front: new LiquidGlassMaterial({
        ...clear,
        samples: 6,
        thickness: 64,
        chromaticAberration: 0.05,
        anisotropicBlur: 0.12,
        clearcoat: 0.6,
      }),
      // back faces stay still: they only add the inner outlines, and bending them as well
      // speckles the creases
      back: new LiquidGlassMaterial({
        ...clear,
        liquid: false,
        samples: 3,
        side: THREE.BackSide,
        thickness: 24,
        chromaticAberration: 0.03,
        anisotropicBlur: 0.08,
        envMapIntensity: 0.6,
      }),
      tail: new LiquidGlassMaterial({
        ...clear,
        samples: 4,
        thickness: 40,
        color: '#d2daff',
        attenuationColor: '#3550ff',
        attenuationDistance: 1.3,
        emissive: '#2e4bff',
        emissiveIntensity: 0.3,
        chromaticAberration: 0.03,
        anisotropicBlur: 0.22,
        envMapIntensity: 2,
      }),
      tailBack: new LiquidGlassMaterial({
        ...clear,
        liquid: false,
        samples: 3,
        side: THREE.BackSide,
        thickness: 20,
        color: '#d2daff',
        attenuationColor: '#3550ff',
        attenuationDistance: 1.3,
        chromaticAberration: 0.02,
        anisotropicBlur: 0.1,
        envMapIntensity: 0.6,
      }),
      drop: new LiquidGlassMaterial({
        ...clear,
        liquid: false,
        samples: 3,
        thickness: 1.5,
        chromaticAberration: 0,
        anisotropicBlur: 0.05,
        envMapIntensity: 1.5,
      }),
    }
  }, [])
  const shapes = useMemo(
    () => ({
      sphere: new THREE.SphereGeometry(1, 48, 32),
      pill: new THREE.CapsuleGeometry(1, 2.6, 12, 32),
      ribbon: rayGeometry(160),
      plane: new THREE.PlaneGeometry(1, 1),
    }),
    [],
  )
  const light = useMemo(() => {
    const hook = (color) =>
      rayMaterial({ color, edge: color, core: 0.2, glow: 1.15, hot: 0.18, halo: 0.34, tail: 0.18 })
    return {
      inbound: rayMaterial({ color: '#ffffff', edge: '#6b7482', core: 0.24, glow: 1.6, halo: 0.3 }),
      // inside the glass the beam rests faint and flares as the pulse crosses: a full-strength
      // white line through the counter would read as a cross with the raking lines
      through: rayMaterial({
        color: '#ffffff',
        edge: '#ffffff',
        core: 0.3,
        glow: 2.2,
        halo: 0.25,
        base: 0.32,
      }),
      hooks: LINES.map(hook),
      rake: LINES.map((color) =>
        rayMaterial({
          color,
          edge: color,
          core: 0.3,
          hot: 0.05,
          halo: 0.2,
          fade: [0.22, 0.3],
          flow: 0.14,
        }),
      ),
      pools: poolMaterial(),
    }
  }, [])
  const buffers = useMemo(() => {
    const opts = { type: THREE.HalfFloatType, depthBuffer: true }
    return [new THREE.WebGLRenderTarget(2, 2, opts), new THREE.WebGLRenderTarget(2, 2, opts)]
  }, [])
  useEffect(
    () => () => {
      mark.body.dispose()
      mark.tail.dispose()
      Object.values(glass).forEach((m) => m.dispose())
      Object.values(shapes).forEach((g) => g.dispose())
      ;[light.inbound, light.through, light.pools, ...light.hooks, ...light.rake].forEach((m) =>
        m.dispose(),
      )
      buffers.forEach((b) => b.dispose())
    },
    [mark, glass, shapes, light, buffers],
  )

  // ---- theme ----------------------------------------------------------------------------------
  const page = useMemo(() => new THREE.Color(dark ? PAGE.dark : PAGE.light), [dark])
  useLayoutEffect(() => {
    // pearl: lines paint crisply onto the page; night: they add light
    const add = dark ? 0.85 : 0.12
    for (const m of [light.inbound, light.through, ...light.hooks, ...light.rake])
      m.uniforms.uAdd.value = add
    light.inbound.uniforms.uEdge.value.set(dark ? '#9fb0ff' : '#5f6876')
    light.inbound.uniforms.uHalo.value = dark ? 0.32 : 0.36
    // Whitening mixes in linear light, so even a little turns the four colours pastel: on pearl
    // the lines stay pure; at night only enough to glow, and the rake adds less light than the
    // hooks so green and yellow over the cobalt pool stay green and yellow.
    for (const m of light.rake) {
      m.uniforms.uOpacity.value = dark ? 0.9 : 0.95
      m.uniforms.uGlow.value = dark ? 1.25 : 1
      m.uniforms.uHot.value = dark ? 0.05 : 0
      m.uniforms.uAdd.value = dark ? 0.55 : 0.12
    }
    for (const m of light.hooks) {
      m.uniforms.uGlow.value = dark ? 1.6 : 1
      m.uniforms.uHot.value = dark ? 0.1 : 0
      // on pearl an all-white pulse would vanish: a white-hot core inside its own colour
      m.uniforms.uPulseHot.value = dark ? 0.7 : 0.3
      m.uniforms.uHalo.value = dark ? 0.34 : 0.42
    }
    glass.front.envMapIntensity = dark ? 1.9 : 1.6 // the faces reflect a dark studio either way
    // pearl: dark flags on the steep bevels (the night studio is dark already)
    const flag = (m, x, lift) => m.uFlag.set(dark ? 0 : x, 0.3, 0.86, dark ? 1 : lift)
    flag(glass.front, 0.85, 1.06)
    flag(glass.back, 0.55, 1.02)
    flag(glass.tail, 0.7, 1.04)
    flag(glass.tailBack, 0.4, 1)
    flag(glass.drop, 0.75, 1.04)
    glass.tail.emissiveIntensity = dark ? 0.3 : 0.12
    // on pearl a deep cobalt slab reads as solid plastic: thinner colour, so it stays glass
    glass.tail.attenuationDistance = glass.tailBack.attenuationDistance = dark ? 1.3 : 1.75
    glass.tail.anisotropicBlur = dark ? 0.22 : 0.08
    glass.tail.uGlowColor.set(dark ? '#8fa4ff' : '#c9d3ff')
    light.pools.uniforms.uAdd.value = dark ? 0.35 : 0
    invalidate()
  }, [dark, light, glass, invalidate])

  // ---- layout: the stage in canvas pixels and world units -------------------------------------
  const frame = useMemo(() => {
    const k = (2 * DISTANCE * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / size.height
    const box = wrap.current.getBoundingClientRect()
    const st = stage.current.getBoundingClientRect()
    const off = [st.left - box.left, st.top - box.top]
    const px = ([x, y]) => [x + off[0], y + off[1]]
    const world = ([x, y], z = 0, out = new THREE.Vector3()) => {
      const f = (DISTANCE - z) / DISTANCE
      return out.set((x - size.width / 2) * k * f, -(y - size.height / 2) * k * f, z)
    }
    const qBox = { x: layout.q.x + off[0], y: layout.q.y + off[1], size: layout.q.size }
    const outs = layout.outs.map((o) => ({ ...o, at: px(o.at) }))
    return {
      k,
      px,
      world,
      qBox,
      outs,
      counter: markPoint(qBox, MARK.counter),
      scale: (k * layout.q.size) / 512,
      feed: px(layout.feed),
      slot: slots(markPoint(qBox, MARK.exit), outs),
    }
  }, [layout, size, wrap, stage])

  // the raking lines and the pools of light only move with the layout
  useLayoutEffect(() => {
    const { world, counter, qBox, k, px } = frame
    const s = qBox.size
    // four lines at 45 degrees through the glass, from the stage's left edge (never over the copy)
    // up to the canvas edge
    const z = -2.4
    const c = [counter[0] - s * 0.1, counter[1] - s * 0.1]
    const from = px([0, 0])[0] + 4 - c[0]
    const to = Math.min(c[1], size.width - c[0])
    light.rake.forEach((m, i) => {
      const o = ((1.5 - i) * s * 0.034) / Math.SQRT2
      const a = world([c[0] - o + from, c[1] - o - from], z)
      const b = world([c[0] - o + to, c[1] - o - to], z)
      const [p0, p1, p2, p3] = m.uniforms.uP.value
      p0.copy(a)
      p1.lerpVectors(a, b, 1 / 3)
      p2.lerpVectors(a, b, 2 / 3)
      p3.copy(b)
      m.uniforms.uWidth.value = 11 * k
    })
    const pool = refs.current.pool
    const pz = -3.4
    const f = (DISTANCE - pz) / DISTANCE
    pool.position.set(0, 0, pz)
    pool.scale.set(size.width * k * f, size.height * k * f, 1)
    const u = light.pools.uniforms
    u.uRes.value.set(size.width, size.height)
    u.uEdgeFade.value.set(size.width * 0.3, size.height * 0.24)
    const at = (dx, dy, r, color, alpha, i) => {
      u.uPool.value[i].set(counter[0] + dx * s, size.height - (counter[1] + dy * s), r * s, alpha)
      u.uPoolColor.value[i].set(color)
    }
    if (dark) {
      at(0, 0.05, 1.25, '#0b1670', 0.9, 0)
      at(0.04, -0.02, 0.72, '#2e4bff', 0.62, 1)
      at(0.12, -0.12, 0.3, '#8fa4ff', 0.3, 2)
      at(0.78, 0.05, 0.42, '#ff3ea5', 0.12, 3)
      at(-0.55, 0.7, 0.4, '#12c26e', 0.08, 4)
      at(0.6, 0.85, 0.36, '#ffc21a', 0.07, 5)
    } else {
      at(0.02, 0.02, 0.78, '#ffffff', 0.95, 0)
      at(0.08, 0.7, 0.46, '#8b95a5', 0.26, 1)
      at(-0.5, -0.42, 0.4, '#2e4bff', 0.16, 2)
      // pink behind the Q's right flank, not behind the readouts (their glass would turn pink)
      at(0.4, -0.3, 0.3, '#ff3ea5', 0.13, 3)
      // a cobalt caustic where light leaves the blue tail
      at(0.62, 0.66, 0.26, '#2e4bff', 0.16, 4)
      at(0.56, 0.72, 0.34, '#ffc21a', 0.14, 5)
    }
    for (const m of [light.inbound, ...light.hooks]) m.uniforms.uWidth.value = 9 * k
    light.through.uniforms.uWidth.value = 8 * k
    invalidate()
  }, [frame, size, light, dark, invalidate])

  // ---- the shared buffers follow the canvas ---------------------------------------------------
  useEffect(() => {
    const ratio = gl.getPixelRatio()
    const w = size.width * ratio * 0.62
    const h = size.height * ratio * 0.62
    const fit = Math.min(1, quality.buffer / Math.max(w, h))
    for (const b of buffers) b.setSize(Math.round(w * fit), Math.round(h * fit))
    glass.back.buffer = buffers[0].texture
    glass.tailBack.buffer = buffers[0].texture
    glass.drop.buffer = buffers[0].texture
    glass.front.buffer = buffers[1].texture
    glass.tail.buffer = buffers[1].texture
    invalidate()
  }, [gl, size, quality, buffers, glass, invalidate])

  // ---- the studio light follows the pointer -------------------------------------------------
  useEffect(() => {
    if (still) return
    const on = (e) => {
      pointer.current.tx = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.ty = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', on, { passive: true })
    return () => window.removeEventListener('pointermove', on)
  }, [still])

  // the readouts and the source pill flash when their pulse lands
  const targets = useMemo(() => {
    const el = stage.current
    return { feed: el.querySelector('.refractor-feed'), outs: [...el.querySelectorAll('.readout')] }
  }, [stage, layout])
  const flash = (el) => el && (el.dataset.hit = el.dataset.hit === 'a' ? 'b' : 'a')

  useEffect(() => {
    if (still) invalidate()
  }, [still, invalidate, layout, dark])

  // ---- every frame ----------------------------------------------------------------------------
  const v = useMemo(
    () => ({
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Vector3(),
      p: new THREE.Vector3(),
    }),
    [],
  )
  useFrame((state, delta) => {
    const r = refs.current
    const c = clock.current
    const dt = still ? 0 : Math.min(delta, 0.1)
    c.t = still ? STILL : c.t + dt
    const t = c.t
    const ph = t % LOOP
    const prev = c.ph
    c.ph = ph
    const crossed = (at) =>
      !still && c.frames > 0 && (prev <= ph ? prev < at && at <= ph : prev < at || at <= ph)
    const wave = (n, phase = 0) => Math.sin((2 * Math.PI * n * t) / LOOP + phase)

    // pointer, eased
    const pt = pointer.current
    pt.x += (pt.tx - pt.x) * Math.min(1, dt * 3)
    pt.y += (pt.ty - pt.y) * Math.min(1, dt * 3)

    // the Q: placed on its box, floating, swaying, tilting to the pointer, jiggling on impact
    const hitIn = since(ph, T.enter)
    const jiggle = hitIn < 2.4 ? Math.exp(-hitIn * 3.4) * Math.sin(hitIn * 15) : 0
    const hitOut = since(ph, T.exit)
    const kick = hitOut < 1.6 ? Math.exp(-hitOut * 4) * Math.sin(hitOut * 18) : 0
    frame.world(frame.counter, 0, r.q.position)
    r.q.position.y += 0.05 * wave(1, 0.4)
    r.q.position.addScaledVector(OUT, 0.035 * jiggle)
    r.q.scale.setScalar(frame.scale)
    r.tilt.rotation.set(
      0.1 + 0.04 * wave(1, 1.1) + pt.y * 0.08,
      -0.24 + 0.12 * wave(1) + pt.x * 0.16,
      0.012 * wave(2, 0.3),
    )
    r.squash.scale.set(1 + 0.05 * jiggle, 1 - 0.05 * jiggle, 1 + 0.02 * jiggle)
    r.tailMesh.position.set(0, 0, 2).addScaledVector(OUT, 6 * kick)
    r.q.updateWorldMatrix(true, true)

    // the glass, liquid
    const imp = (m) => {
      m.uniforms.uTime.value = t
      m.uniforms.uRipple.value = 6.5
      m.uniforms.uImpact.value[0].set(ENTRY.x, ENTRY.y, 0, hitIn < 3 ? hitIn : -1)
      m.uniforms.uImpact.value[1].set(EXIT.x - 30, EXIT.y + 30, 0, hitOut < 3 ? hitOut * 0.9 : -1)
    }
    imp(glass.front)
    imp(glass.tail)
    const sweep = since(ph, arrival(3) - 0.2)
    const sw = glass.front.uniforms.uSweep.value
    sw.set(-1.6 + Math.min(sweep, 1.6) * 2.1, 0.16, sweep < 1.6 ? (dark ? 2.2 : 1.5) : 0)
    glass.tail.uniforms.uSweep.value.copy(sw)
    for (const m of [glass.front, glass.tail]) {
      m.uniforms.uPointer.value.set(pt.x * 0.55, -pt.y * 0.45, 1, 0).normalize()
      m.uniforms.uPointer.value.w = still ? 0 : dark ? 2.2 : 1.5
    }
    // the white pulse lights the glass from inside as it crosses
    const cross = (ph - T.enter) / (T.exit - T.enter)
    const glow = glass.front.uniforms.uGlow.value
    if (cross > -0.15 && cross < 1.25) {
      v.p.lerpVectors(ENTRY, EXIT, Math.min(1, Math.max(0, cross)))
      glow.set(v.p.x, v.p.y, 0, (dark ? 2.4 : 1.4) * Math.sin(Math.PI * ease((cross + 0.15) / 1.4)))
    } else glow.w = 0
    glass.tail.uniforms.uGlow.value.set(
      EXIT.x,
      EXIT.y,
      0,
      hitOut < 1 ? (dark ? 1.4 : 0.8) * Math.exp(-hitOut * 3) : 0,
    )
    glass.tail.emissiveIntensity =
      (dark ? 0.3 : 0.12) + (hitOut < 1 ? 0.7 * Math.exp(-hitOut * 4) : 0)

    // the beam: in from the source pill, then straight through the glass to the tail
    const toPx = (vec) => {
      v.c.copy(vec).project(camera)
      return [((v.c.x + 1) / 2) * size.width, ((1 - v.c.y) / 2) * size.height]
    }
    const outside = v.a.copy(ENTRY).applyMatrix4(r.body.matrixWorld)
    const surface = toPx(v.c.copy(SURFACE).applyMatrix4(r.body.matrixWorld))
    const exitW = v.b.copy(EXIT).applyMatrix4(r.body.matrixWorld)
    const exitPx = toPx(v.p.set(TAIL_EXIT[0], TAIL_EXIT[1], 0).applyMatrix4(r.body.matrixWorld))
    const { inbound } = beamCurves(frame.feed, surface, exitPx, frame.qBox.size)
    const bi = light.inbound.uniforms.uP.value
    frame.world(inbound[0], 0, bi[0])
    frame.world(inbound[1], 0, bi[1])
    frame.world(inbound[2], 0, bi[2])
    bi[3].copy(outside)
    const bt = light.through.uniforms.uP.value
    bt[0].copy(outside)
    bt[1].lerpVectors(outside, exitW, 1 / 3)
    bt[2].lerpVectors(outside, exitW, 2 / 3)
    bt[3].copy(exitW)
    const run = (m, from, to) => {
      const x = (ph - from) / (to - from)
      m.uniforms.uHead.value = x
      m.uniforms.uPulse.value = x < 0 ? 0 : x <= 1 ? 1 : Math.max(0, 1 - (x - 1) * 5)
      m.uniforms.uTime.value = t
    }
    run(light.inbound, 0, T.enter)
    run(light.through, T.enter, T.exit)
    if (crossed(0.001)) flash(targets.feed)

    // the hook lines, from the swaying tail to their readouts
    frame.outs.forEach((o, i) => {
      const curve = hookCurve(exitPx, frame.slot[i], o, frame.qBox.size)
      const u = light.hooks[i].uniforms.uP.value
      curve.forEach((p, j) => frame.world(p, 0, u[j]))
      run(light.hooks[i], T.exit + i * T.spread, arrival(i))
      if (crossed(arrival(i))) flash(targets.outs[i])
    })
    for (const m of light.rake) m.uniforms.uTime.value = t

    // droplets bob
    r.drops.forEach((d, i) => {
      const b = d.userData
      frame.world(
        [
          frame.counter[0] + b.at[0] * frame.qBox.size,
          frame.counter[1] + b.at[1] * frame.qBox.size,
        ],
        b.z,
        d.position,
      )
      d.position.y += 0.07 * wave(1, i * 1.7)
      d.position.x += 0.03 * wave(2, i)
      d.rotation.set(b.rot[0] + 0.2 * wave(1, i), b.rot[1], b.rot[2] + 0.15 * wave(1, i * 2.3))
      d.scale.setScalar(b.size * frame.qBox.size * frame.k)
    })

    // ---- the three passes ----
    const pieces = [r.body, r.tailMesh, ...r.drops]
    for (const m of pieces) m.visible = false
    scene.background = page
    gl.setRenderTarget(buffers[0])
    gl.render(scene, camera)
    r.body.visible = r.tailMesh.visible = true
    r.body.material = glass.back
    r.tailMesh.material = glass.tailBack
    gl.setRenderTarget(buffers[1])
    gl.render(scene, camera)
    r.body.material = glass.front
    r.tailMesh.material = glass.tail
    for (const m of pieces) m.visible = true
    scene.background = null
    gl.setRenderTarget(null)
    gl.render(scene, camera)

    if (++c.frames === 2) onReady?.()
    // reduced motion renders on demand: a few frames let the studio and buffers settle
    if (still && c.frames < 4) invalidate()
  }, 1)

  return (
    <>
      <HeroStudio key={dark ? 'night' : 'pearl'} dark={dark} />
      <ambientLight intensity={0.2} />
      <directionalLight position={[-5, 6, 8]} intensity={dark ? 2.6 : 2.2} />

      <mesh
        ref={(m) => (refs.current.pool = m)}
        geometry={shapes.plane}
        material={light.pools}
        renderOrder={-3}
        frustumCulled={false}
      />
      {light.rake.map((m, i) => (
        <mesh
          key={i}
          geometry={shapes.ribbon}
          material={m}
          renderOrder={-2}
          frustumCulled={false}
        />
      ))}
      <mesh geometry={shapes.ribbon} material={light.inbound} frustumCulled={false} />
      <mesh geometry={shapes.ribbon} material={light.through} frustumCulled={false} />
      {light.hooks.map((m, i) => (
        <mesh key={i} geometry={shapes.ribbon} material={m} frustumCulled={false} />
      ))}

      <group ref={(g) => (refs.current.q = g)}>
        <group ref={(g) => (refs.current.tilt = g)}>
          <group rotation-z={-Math.PI / 4}>
            <group ref={(g) => (refs.current.squash = g)}>
              <group rotation-z={Math.PI / 4}>
                <mesh
                  ref={(m) => (refs.current.body = m)}
                  geometry={mark.body}
                  material={glass.front}
                />
                <mesh
                  ref={(m) => (refs.current.tailMesh = m)}
                  geometry={mark.tail}
                  material={glass.tail}
                />
              </group>
            </group>
          </group>
        </group>
      </group>

      {DROPS.map((d, i) => (
        <mesh
          key={i}
          ref={(m) => (refs.current.drops[i] = m)}
          geometry={d.pill ? shapes.pill : shapes.sphere}
          material={glass.drop}
          userData={d}
        />
      ))}
    </>
  )
}
