// The fee flywheel, live: the glass donut chart from the card's still (60% to holders in
// Entanglement green, 40% to buyback and burn in Quantum Burn pink) inside the glowing arrow ring,
// telling the loop in light: trades leave the ring as white light and drop into the hub, the 7% fee
// flares, a green stream carries 60% into the holders slice (SOL rises out towards holders), a pink
// one carries 40% into the burn slice (embers flicker out), and the ring surges round again.
//
// Loaded lazily by components/Flywheel.jsx (never in the main bundle). The card's HTML labels and
// step chips are driven from here through flywheelHud.js, on the same clock as the light.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { MeshTransmissionMaterial, PerformanceMonitor, useFBO } from '@react-three/drei'
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import { GlassStudio, dotTexture } from './kit.jsx'
import { BEATS, ENTER, LOOP } from './flywheelTimeline.js'
import {
  ASPECT,
  CAMERA,
  HUB,
  PIE,
  onChart,
  ringArcs,
  sliceAngles,
  sliceGeometry,
  splitCurve,
  tradeCurves,
} from './flywheelShapes.js'
import { SparkPool, createBackdrop, lineMaterial } from './flywheelMaterials.js'
import { createHud } from './flywheelHud.js'

// useFrame order: the rig moves everything, the glass pass renders what the glass sees, then the
// composer draws the frame (any positive priority also turns off R3F's own render).
const PRIORITY = { rig: -1, glass: 1, post: 2 }

/**
 * Quality steps, walked down (and back up) by drei's PerformanceMonitor. `glass` caps the
 * transmission buffers; without `backside` the slices' inner walls are cheap tinted stand-ins.
 * Edges are smoothed by FXAA on every tier: the composer's MSAA buffers with bloom render the
 * whole card black on D3D (ANGLE) GPUs.
 */
const TIERS = [
  { dpr: 1, glass: 384, backside: false, dust: 16, distortion: 0 },
  { dpr: 1.25, glass: 512, backside: true, dust: 32, distortion: 0 },
  { dpr: 1.5, glass: 768, backside: true, dust: 48, distortion: 0.18 },
  { dpr: 1.75, glass: 1024, backside: true, dust: 64, distortion: 0.18 },
]
const SLICE_THICKNESS = 2.2
/** The slices' own glow: enough to read as lit colour, low enough that they stay see-through. */
const SLICE_GLOW = 0.5
const BACK_THICKNESS = 0.6

// The still's backdrop (ad/src/social/Flywheel.jsx GLOWS), in shares of the 16:9 frame.
const GLOWS = [
  { x: 0.5, y: 0.5, r: 0.75, color: '#0e1e8e', alpha: 0.8 },
  { x: 0.66, y: 0.28, r: 0.3, color: '#2e4bff', alpha: 0.7 },
  { x: 0.18, y: 0.3, r: 0.3, color: '#172dbe', alpha: 0.5 },
]

/** Where the HTML labels sit in the still (shares of the frame) and what depth they float at. */
const LABELS = {
  fee: { at: [0.66375, 0.17], depth: [0, 1.6, 0] },
  burn: { at: [0.475, 0.3244], depth: onChart(Math.PI * 0.86, 2.2, 0.8).toArray() },
  holders: { at: [0.8719, 0.3333], depth: onChart(-0.2, 2.5, 1).toArray() },
}

const COL = {
  white: new THREE.Color('#ffffff'),
  ice: new THREE.Color('#dfe5ff'),
  lavender: new THREE.Color('#8fa4ff'),
  green: new THREE.Color('#12C26E'),
  greenHi: new THREE.Color('#5cf0a6'),
  pink: new THREE.Color('#FF3EA5'),
  pinkHi: new THREE.Color('#ff8cc8'),
}

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const easeOut = (x) => 1 - (1 - clamp01(x)) ** 3
const backOut = (x) => {
  const t = clamp01(x) - 1
  return 1 + 2.2 * t ** 3 + 1.2 * t ** 2
}
/** 0 before the event, then a fast rise and an exponential fall (x = seconds since). */
const flash = (x, fall = 3, rise = 0.08) => (x < 0 ? 0 : smooth(0, rise, x) * Math.exp(-x * fall))
/** A soft 0→1→0 bump across [a, b]. */
const bump = (x, a, b) => smooth(a, a + (b - a) * 0.25, x) * (1 - smooth(a + (b - a) * 0.7, b, x))
const TMP = new THREE.Vector3()
const EMBER = new THREE.Color()
const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

export default function FlywheelScene({ active, dom, onReady, onLost }) {
  const [warm, setWarm] = useState(false)
  const [tier0] = useState(() => (window.innerWidth < 760 ? 2 : 3))
  const lost = useRef(onLost)
  useEffect(() => {
    lost.current = onLost
  })
  // R3F forces a context loss when the canvas unmounts (reduced motion switched on, HMR): that is
  // not a failure, and reporting it would keep the still up for good.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return (
    <div className="fw-live" aria-hidden="true">
      <Canvas
        frameloop={active && warm ? 'always' : 'never'}
        dpr={Math.min(window.devicePixelRatio || 1, TIERS[tier0].dpr)}
        flat
        gl={{
          antialias: false,
          alpha: false,
          stencil: false,
          powerPreference: 'high-performance',
        }}
        camera={{ fov: CAMERA.fov, near: 0.1, far: 120, position: CAMERA.pos }}
        resize={{ scroll: false }}
        style={{ pointerEvents: 'none' }}
        onCreated={({ gl }) => {
          gl.setClearColor('#04061a', 1)
          gl.domElement.addEventListener(
            'webglcontextlost',
            () => mounted.current && lost.current?.(),
            { once: true },
          )
        }}
      >
        <World dom={dom} tier0={tier0} onReady={onReady} onWarm={() => setWarm(true)} />
      </Canvas>
    </div>
  )
}

function World({ dom, tier0, onReady, onWarm }) {
  const { gl, scene, camera, size, setDpr } = useThree()
  const [tier, setTier] = useState(tier0)
  const q = TIERS[tier]

  useLayoutEffect(() => setDpr(Math.min(window.devicePixelRatio || 1, q.dpr)), [q.dpr, setDpr])

  const hud = useMemo(() => createHud(dom), [dom])
  useEffect(() => () => hud.reset(), [hud])

  const ready = useRef(onReady)
  useEffect(() => {
    ready.current = onReady
  })

  // Compile every program off the main thread before the first frame, so the card does not hitch
  // on scroll. Without the extension three would only warn and compile synchronously anyway.
  useEffect(() => {
    let alive = true
    const done = () => alive && onWarm()
    try {
      if (gl.extensions.has('KHR_parallel_shader_compile'))
        gl.compileAsync(scene, camera).then(done, done)
      else done()
    } catch {
      done()
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- what the scene is made of --------------------------------------------------------------

  const slices = useMemo(() => sliceAngles(), [])
  const sliceGeos = useMemo(
    () => slices.map((s) => sliceGeometry(s.start, s.end, s.depth)),
    [slices],
  )
  // The slices' inner walls, as the glass pass sees them: tinted, lit glass seen from inside.
  const proxies = useMemo(
    () =>
      slices.map(
        (s) =>
          new THREE.MeshStandardMaterial({
            color: s.color,
            emissive: s.color,
            emissiveIntensity: 0.25,
            roughness: 0.06,
            side: THREE.BackSide,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
            envMapIntensity: 1.6,
          }),
      ),
    [slices],
  )
  const backdrop = useMemo(() => createBackdrop({ base: '#04061a', glows: GLOWS }), [])
  const ring = useMemo(() => buildRing(), [])
  const flow = useMemo(() => buildFlow(slices), [slices])
  const ripples = useMemo(() => buildRipples(slices, flow.land), [slices, flow])
  const sparks = useMemo(() => new SparkPool(360), [])
  const hubFx = useMemo(() => buildHub(), [])
  const pool = useMemo(() => buildPool(slices), [slices])
  const sphere = useMemo(() => new THREE.SphereGeometry(1, 64, 48), [])
  const pill = useMemo(() => new THREE.CapsuleGeometry(0.5, 2.2, 16, 48), [])

  useEffect(
    () => () => {
      sliceGeos.forEach((g) => g.dispose())
      proxies.forEach((m) => m.dispose())
      backdrop.geometry.dispose()
      backdrop.material.dispose()
      ring.dispose()
      flow.dispose()
      sparks.dispose()
      ripples.dispose()
      hubFx.dispose()
      pool.dispose()
      sphere.dispose()
      pill.dispose()
    },
    [sliceGeos, proxies, backdrop, ring, flow, ripples, sparks, hubFx, pool, sphere, pill],
  )

  const chart = useRef(null)
  const sliceGroups = useRef([])
  const sliceMeshes = useRef([])
  const sliceMats = useRef([])
  const pieces = useRef([])

  // ---- the glass passes -----------------------------------------------------------------------
  // All the glass shares two transmission buffers instead of each piece re-rendering the scene
  // for itself: `behind` is the scene without any glass, and `through` adds the slices' back faces
  // (refracting `behind`), which the slices' front faces then refract. That is what drei's
  // backside option does per material, done once for the whole chart. The cheapest tier skips the
  // back faces and draws tinted stand-ins for them instead. The buffers are never bigger than the
  // canvas needs (a phone's crop is a few hundred pixels across).
  const dpr = Math.min(window.devicePixelRatio || 1, q.dpr)
  const res = Math.min(q.glass, Math.ceil((Math.max(size.width, size.height) * dpr) / 128) * 128)
  const behind = useFBO(res, res)
  const through = useFBO(q.backside ? res : 1, q.backside ? res : 1)
  const sliceBuffer = q.backside ? through.texture : behind.texture
  const hidden = useMemo(() => [], [])
  useFrame(({ gl: r, scene: s, camera: c }) => {
    const meshes = sliceMeshes.current
    const mats = sliceMats.current
    // the floating glass stays out of the buffers it refracts (no per-frame arrays)
    hidden.length = 0
    for (const m of pieces.current) {
      if (m && m.visible) {
        m.visible = false
        hidden.push(m)
      }
    }
    meshes.forEach((m, i) => {
      if (!m) return
      if (q.backside) m.visible = false
      else m.material = proxies[i]
    })
    r.setRenderTarget(behind)
    r.clear()
    r.render(s, c)
    if (q.backside) {
      meshes.forEach((m, i) => {
        const mat = mats[i]
        if (!m || !mat) return
        m.visible = true
        mat.buffer = behind.texture
        mat.thickness = BACK_THICKNESS
        mat.side = THREE.BackSide
        mat.needsUpdate = true
      })
      r.setRenderTarget(through)
      r.clear()
      r.render(s, c)
      meshes.forEach((m, i) => {
        const mat = mats[i]
        if (!m || !mat) return
        mat.buffer = through.texture
        mat.thickness = SLICE_THICKNESS
        mat.side = THREE.FrontSide
        mat.needsUpdate = true
      })
    } else {
      meshes.forEach((m, i) => m && (m.material = mats[i]))
    }
    r.setRenderTarget(null)
    for (const m of hidden) m.visible = true
  }, PRIORITY.glass)

  // ---- framing --------------------------------------------------------------------------------
  // The canvas may show only part of the 16:9 frame (narrow cards crop it): render that part with
  // a view offset so the chart, and the labels over it, keep the still's positions.
  const view = useMemo(() => ({ fullW: 16, fullH: 9, x: 0, y: 0, w: 16, h: 9 }), [])
  useLayoutEffect(() => {
    const frame = dom.frame.current
    if (!frame) return
    const f = frame.getBoundingClientRect()
    const c = gl.domElement.getBoundingClientRect()
    if (!f.width || !c.width) return
    Object.assign(view, {
      fullW: f.width,
      fullH: f.height,
      x: c.left - f.left,
      y: c.top - f.top,
      w: c.width,
      h: c.height,
    })
    camera.manual = true
    camera.aspect = f.width / f.height
    if (Math.abs(f.width - c.width) < 1 && Math.abs(f.height - c.height) < 1)
      camera.clearViewOffset()
    else camera.setViewOffset(f.width, f.height, view.x, view.y, view.w, view.h)
    camera.updateProjectionMatrix()
    backdrop.material.uniforms.uView.value.set(
      view.x / view.fullW,
      1 - (view.y + view.h) / view.fullH,
      view.w / view.fullW,
      view.h / view.fullH,
    )
    backdrop.material.uniforms.uAspect.value = view.fullW / view.fullH
  }, [size, gl, camera, dom, view, backdrop])

  // Label anchors: the 3D point under each label in the still, so moving the camera or a slice
  // moves its label by exactly what the still would have moved.
  const anchors = useMemo(() => {
    const rest = restCamera()
    const center = new THREE.Vector3(...PIE.center)
    const out = {}
    for (const [key, { at, depth }] of Object.entries(LABELS)) {
      const ref = new THREE.Vector3(...depth).add(center)
      const z = ref.project(rest).z
      const world = new THREE.Vector3(at[0] * 2 - 1, 1 - at[1] * 2, z).unproject(rest)
      const slice = slices.findIndex((s) => s.key === key)
      const local = world.sub(center)
      if (slice >= 0) local.sub(sliceRest(slices[slice]))
      out[key] = { key, at, local, slice }
    }
    return out
  }, [slices])
  const anchorList = useMemo(() => Object.values(anchors), [anchors])
  const fullCam = useMemo(() => restCamera(), [])

  // ---- pointer --------------------------------------------------------------------------------

  const rig = useMemo(
    () => ({
      t: 0,
      mode: 'boot',
      enterAt: 0,
      loopAt: 0,
      prev: -1,
      frames: 0,
      aimX: 0,
      aimY: 0,
      px: 0,
      py: 0,
      spin: 0,
      phase: 0,
      stepped: 0,
    }),
    [],
  )
  useEffect(() => {
    const el = dom.stage.current
    if (!el) return
    const move = (e) => {
      if (e.pointerType === 'touch') return
      const r = el.getBoundingClientRect()
      rig.aimX = ((e.clientX - r.left) / r.width) * 2 - 1
      rig.aimY = ((e.clientY - r.top) / r.height) * 2 - 1
    }
    const leave = () => {
      rig.aimX = 0
      rig.aimY = 0
    }
    el.addEventListener('pointermove', move, { passive: true })
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
    }
  }, [dom, rig])

  // ---- the rig: one clock moves everything ----------------------------------------------------

  const tmp = useMemo(
    () => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), buf: new THREE.Vector2() }),
    [],
  )
  useFrame((state, delta) => {
    const dt = Math.min(delta, 1 / 20)
    rig.t += dt
    const t = rig.t

    // where the chart is (on narrow cards it sits below the copy): decides the entrance, and tilts
    // the camera as it scrolls past
    const box = dom.art.current?.getBoundingClientRect()
    const vh = window.innerHeight || 1
    const seen = box ? Math.max(0, Math.min(box.bottom, vh) - Math.max(box.top, 0)) : vh
    const scroll = box ? Math.max(-1, Math.min(1, (box.top + box.height / 2 - vh / 2) / vh)) : 0

    if (rig.mode === 'boot') {
      // already in view: no entrance, cross-fade from the still to the full chart
      rig.mode = seen > 80 ? 'loop' : 'idle'
      rig.loopAt = t
    }
    if (rig.mode === 'idle' && box && seen >= Math.min(box.height * 0.25, vh * 0.25)) {
      rig.mode = 'enter'
      rig.enterAt = t
    }
    if (rig.mode === 'enter' && t - rig.enterAt >= ENTER) {
      rig.mode = 'loop'
      rig.loopAt = t
    }
    const e = rig.mode === 'idle' ? 0 : rig.mode === 'enter' ? (t - rig.enterAt) / ENTER : 1
    const es = e * ENTER // seconds into the entrance
    const tau = rig.mode === 'loop' ? (t - rig.loopAt) % LOOP : -1

    // beats crossed since the last frame
    const prev = rig.prev
    const crossed = (b) =>
      prev >= 0 && tau >= 0 && (tau >= prev ? prev < b && b <= tau : prev < b || b <= tau)
    if (crossed(BEATS.fee)) hud.beat('fee')
    if (crossed(BEATS.holders)) hud.beat('holders')
    if (crossed(BEATS.burn)) hud.beat('burn')
    if (crossed(BEATS.coins[0] + BEATS.coinFlight * 0.9)) hud.beat('holders-chip')
    if (crossed(BEATS.burn + 0.5)) hud.beat('burn-chip')
    rig.prev = tau
    hud.steps(tau)

    // camera: pointer parallax, a slow idle drift, and a tilt with scroll
    const k = 1 - Math.exp(-dt * 2.4)
    rig.px += (rig.aimX - rig.px) * k
    rig.py += (rig.aimY - rig.py) * k
    const cam = state.camera
    cam.position.set(
      CAMERA.pos[0] + rig.px * 1.05 + Math.sin(t * 0.21) * 0.25,
      CAMERA.pos[1] - rig.py * 0.55 - scroll * 0.6 + Math.sin(t * 0.17) * 0.09,
      CAMERA.pos[2],
    )
    cam.lookAt(CAMERA.target[0], CAMERA.target[1], CAMERA.target[2])
    cam.updateMatrixWorld()

    // the chart sways a touch on its own
    const ch = chart.current
    if (ch) {
      ch.rotation.y = Math.sin(t * 0.25) * 0.035
      ch.position.y = Math.sin(t * 0.6) * 0.025
    }

    // slices: rise in, then breathe; a stream landing makes its slice flash and give a little
    slices.forEach((s, i) => {
      const g = sliceGroups.current[i]
      const mat = sliceMats.current[i]
      if (!g) return
      const p = (es - 0.1 - i * 0.28) / 1.35
      const rise = backOut(p)
      g.visible = p > 0
      const land = i === 0 ? BEATS.holders : BEATS.burn
      const since = tau - land
      const give = since > 0 ? -0.075 * Math.exp(-since * 4.5) * Math.sin(since * 13) : 0
      const breathe = Math.sin(t * 1.05 + i * 1.9) * 0.045 * e
      const r = PIE.gap + Math.sin(t * 0.8 + i * 2.4) * 0.025 * e
      g.position.set(Math.cos(s.mid) * r, (1 - rise) * -2.6 + breathe + give, -Math.sin(s.mid) * r)
      g.rotation.y = (1 - rise) * (i === 0 ? -0.9 : 0.9)
      // and wobbles like a liquid as it takes the stream in: squashed down, then springing back
      const wob = since > 0 ? Math.exp(-since * 4) * Math.sin(since * 15) : 0
      const size = 0.72 + 0.28 * rise
      g.scale.set(size * (1 + wob * 0.018), size * (1 - wob * 0.06), size * (1 + wob * 0.018))
      if (mat) {
        mat.emissiveIntensity =
          SLICE_GLOW +
          Math.sin(t * 1.3 + i) * 0.05 +
          flash(since, 1.6) * 0.35 +
          (1 - easeOut(p)) * 0.6
      }
    })

    // labels follow their anchors
    if (ch) ch.updateWorldMatrix(true, true)
    fullCam.position.copy(cam.position)
    fullCam.quaternion.copy(cam.quaternion)
    fullCam.updateMatrixWorld()
    for (const a of anchorList) {
      const { key } = a
      const el = hud.labels[key]
      if (!el) continue
      const parent = a.slice >= 0 ? sliceGroups.current[a.slice] : ch
      if (!parent) continue
      tmp.v.copy(a.local).applyMatrix4(parent.matrixWorld).project(fullCam)
      const x = ((tmp.v.x + 1) / 2 - a.at[0]) * view.fullW
      const y = ((1 - tmp.v.y) / 2 - a.at[1]) * view.fullH
      let o = null
      if (rig.mode !== 'loop') {
        const from = key === 'fee' ? 0.6 : key === 'burn' ? 0.52 : 0.44
        o = smooth(from, from + 0.25, e)
      }
      hud.place(el, x, y, o)
    }

    // ring: draws on, spins clockwise, comets run round it, and it surges on the turn
    const surge = tau >= 0 ? bump(tau, ...BEATS.turn) : 0
    rig.spin -= dt * (0.16 + surge * 0.6)
    rig.phase += dt * (0.34 + surge * 1.1)
    ring.update({ draw: easeOut((es - 0.05) / 1.6), spin: rig.spin, phase: rig.phase, surge, e })

    flow.update({ tau, t, e })
    hubFx.update({ tau, t, e })
    pool.update({ t, tau, e })

    // sparks
    sparks.material.uniforms.uScale.value =
      (cam.projectionMatrix.elements[5] * state.gl.getDrawingBufferSize(tmp.buf).y) / 2
    emitDust(sparks, t, e, q.dust)
    emitOrbit(sparks, t, e, rig.phase, q.dust)
    flow.emit(sparks, tau)
    emitBurst(sparks, tau, BEATS.holders, flow.land[0], COL.greenHi, 18, 1)
    emitBurst(sparks, tau, BEATS.burn, flow.land[1], COL.pinkHi, 22, 2)
    emitEmbers(sparks, tau, t, slices[1])
    emitSol(sparks, tau, flow.land[0], anchors.holders.local)
    ripples.update(tau)
    hubFx.emit(sparks, tau, t)
    sparks.commit()

    // the glass pieces bob
    pieces.current.forEach((m, i) => {
      if (!m) return
      const b = PIECES[i]
      m.position.set(
        b.pos[0] + Math.sin(t * 0.5 + i * 2.1) * 0.08,
        b.pos[1] + Math.sin(t * 0.7 + i * 1.3) * 0.16,
        b.pos[2],
      )
      m.rotation.set(b.rot[0] + t * 0.05, b.rot[1] + Math.sin(t * 0.3 + i) * 0.2, b.rot[2])
    })
    backdrop.material.uniforms.uTime.value = t
    // the studio turns a little, so reflections slide across the glass like liquid
    state.scene.environmentRotation.set(0, Math.sin(t * 0.23) * 0.28, Math.sin(t * 0.17) * 0.06)

    if (++rig.frames === 3) ready.current?.()
  }, PRIORITY.rig)

  return (
    <>
      <PerformanceMonitor
        flipflops={3}
        onDecline={() => {
          rig.stepped = -1
          setTier((n) => Math.max(0, n - 1))
        }}
        onIncline={() => {
          rig.stepped = 1
          setTier((n) => Math.min(TIERS.length - 1, n + 1))
        }}
        // the monitor gives up after a few steps either way: settle on the last tier that held its
        // frame rate (one down if the last step was up), not on the lowest
        onFallback={() => rig.stepped > 0 && setTier((n) => Math.max(0, n - 1))}
      />
      <GlassStudio mood="cobalt" resolution={tier0 > 2 ? 512 : 256} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[-4, 9, 6]} intensity={2.4} />
      <primitive object={backdrop} />

      <group ref={chart} position={PIE.center}>
        {slices.map((s, i) => (
          <group key={s.key} ref={(el) => (sliceGroups.current[i] = el)} visible={false}>
            <mesh geometry={sliceGeos[i]} ref={(el) => (sliceMeshes.current[i] = el)}>
              <MeshTransmissionMaterial
                ref={(el) => (sliceMats.current[i] = el)}
                buffer={sliceBuffer}
                resolution={16}
                samples={6}
                color={s.light}
                attenuationColor={s.color}
                attenuationDistance={2.6}
                emissive={s.color}
                emissiveIntensity={SLICE_GLOW}
                thickness={SLICE_THICKNESS}
                roughness={0}
                ior={1.45}
                chromaticAberration={0.06}
                anisotropicBlur={0.05}
                clearcoat={1}
                clearcoatRoughness={0}
                envMapIntensity={2.4}
                distortion={q.distortion}
                distortionScale={0.4}
                temporalDistortion={0.08}
              />
            </mesh>
            {ripples.sets[i].map((m, j) => (
              <primitive key={j} object={m} />
            ))}
          </group>
        ))}
        <primitive object={pool.mesh} />
        <primitive object={ring.group} />
        <primitive object={flow.group} />
        <primitive object={hubFx.group} />
        <primitive object={sparks.points} />
      </group>

      {PIECES.map((p, i) => (
        <mesh
          key={i}
          ref={(el) => (pieces.current[i] = el)}
          geometry={p.kind === 'pill' ? pill : sphere}
          position={p.pos}
          scale={p.scale}
        >
          <MeshTransmissionMaterial
            buffer={behind.texture}
            resolution={16}
            samples={6}
            thickness={2.4}
            roughness={p.frost ?? 0}
            anisotropicBlur={p.frost ? 0.3 : 0.08}
            ior={1.45}
            chromaticAberration={0.12}
            clearcoat={1}
            clearcoatRoughness={0}
            envMapIntensity={1.8}
            color={p.tint ? '#c3cdff' : '#ffffff'}
            attenuationColor={p.tint ? '#2e4bff' : '#e8eeff'}
            attenuationDistance={p.tint ? 1.4 : 3}
          />
        </mesh>
      ))}

      <Post />
    </>
  )
}

/** Glass around the edges, kept off the copy on the left (as in the still). */
const PIECES = [
  { kind: 'sphere', pos: [6.2, 2.2, 1.0], rot: [0, 0, 0], scale: 0.22 },
  { kind: 'sphere', pos: [0.0, 2.4, -2.5], rot: [0, 0, 0], scale: 0.16 },
  { kind: 'sphere', pos: [4.2, -0.3, 3.4], rot: [0, 0, 0], scale: 0.22 },
  { kind: 'sphere', pos: [6.7, -0.9, -1.6], rot: [0, 0, 0], scale: 0.12 },
  {
    kind: 'pill',
    pos: [-8.5, 4.4, -9],
    rot: [0.3, 0.3, -0.7],
    scale: 1,
    frost: 0.25,
    tint: true,
  },
]

function restCamera() {
  const c = new THREE.PerspectiveCamera(CAMERA.fov, ASPECT, 0.1, 120)
  c.position.set(...CAMERA.pos)
  c.lookAt(...CAMERA.target)
  c.updateMatrixWorld()
  c.updateProjectionMatrix()
  return c
}

const sliceRest = (s) => new THREE.Vector3(Math.cos(s.mid) * PIE.gap, 0, -Math.sin(s.mid) * PIE.gap)

/** Bloom (only HDR light blooms), neutral tone mapping and a vignette, as in the ad's stills. */
function Post() {
  const { gl, scene, camera, size, viewport } = useThree()
  const fx = useMemo(() => {
    const c = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 })
    c.addPass(new RenderPass(scene, camera))
    const pass = new EffectPass(
      camera,
      new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: 1,
        luminanceSmoothing: 0.25,
        intensity: 0.8,
        radius: 0.72,
      }),
      new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }),
      new VignetteEffect({ offset: 0.32, darkness: 0.45 }),
    )
    pass.dithering = true
    c.addPass(pass)
    // the glass's thin specular glints otherwise crawl as stair-steps while the slices breathe
    const aa = new EffectPass(camera, new FXAAEffect())
    aa.dithering = true
    c.addPass(aa)
    return c
  }, [gl, scene, camera])
  useLayoutEffect(() => fx.setSize(size.width, size.height), [fx, size, viewport.dpr])
  useEffect(() => () => fx.dispose(), [fx])
  useFrame((_, delta) => fx.render(delta), PRIORITY.post)
  return null
}

// ---- the arrow ring ----------------------------------------------------------------------------

const TIP_FLAT = 0.62

function buildRing() {
  const group = new THREE.Group()
  const arcs = ringArcs()
  const geos = []
  const mats = []
  const tube = (curve, r) => {
    const g = new THREE.TubeGeometry(curve, 220, r, 10, false)
    geos.push(g)
    return g
  }
  const parts = arcs.map((a) => {
    const core = lineMaterial({
      color: '#c9d3ff',
      base: 2.6,
      gain: 5,
      len: 0.28,
      ramp: 0.55,
      soft: 0.3,
    })
    const halo = lineMaterial({
      color: '#8fa4ff',
      base: 0.2,
      gain: 0.5,
      len: 0.28,
      ramp: 0.55,
      soft: 2.2,
      fade: 0.04,
    })
    const spill = lineMaterial({
      color: '#5a72ff',
      base: 0.05,
      gain: 0.1,
      len: 0.28,
      ramp: 0.5,
      soft: 3,
      fade: 0.1,
    })
    mats.push(core, halo, spill)
    const arc = new THREE.Group()
    arc.add(new THREE.Mesh(tube(a.curve, 0.024), core))
    arc.add(new THREE.Mesh(tube(a.curve, 0.08), halo))
    arc.add(new THREE.Mesh(tube(a.curve, 0.34), spill))
    const tipMat = new THREE.MeshBasicMaterial({
      color: COL.ice.clone().multiplyScalar(3),
      toneMapped: false,
    })
    mats.push(tipMat)
    // bold enough to read as arrows from across the card, flattened a little into the ring plane
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.46, 32), tipMat)
    geos.push(tip.geometry)
    tip.position.copy(a.tip)
    tip.quaternion.copy(a.quaternion)
    tip.scale.set(1, 1, TIP_FLAT)
    const glowMat = new THREE.SpriteMaterial({
      map: dotTexture(),
      color: COL.lavender.clone(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    })
    mats.push(glowMat)
    const glow = new THREE.Sprite(glowMat)
    glow.position.copy(a.tip)
    arc.add(tip, glow)
    group.add(arc)
    return { lines: [core, halo, spill], tip, tipMat, glow, glowMat }
  })
  return {
    group,
    update({ draw, spin, phase, surge, e }) {
      group.rotation.y = spin
      parts.forEach((p, i) => {
        const h0 = (((phase + i * 0.21) % 1) + 1) % 1
        const h1 = (h0 + 0.5) % 1
        // two comets per arc; they run on past the end so their tails leave too
        const c0 = h0 * 1.3 - 0.05
        const c1 = h1 * 1.3 - 0.05
        for (const m of p.lines) {
          m.uniforms.uDraw.value = draw
          m.uniforms.uHeads.value.set(c0, c1, -9)
          m.uniforms.uOpacity.value = 1 + surge * 0.7
        }
        // a comet reaching the arrowhead lights it
        const hit = Math.exp(-Math.abs(c0 - 1) * 9) + Math.exp(-Math.abs(c1 - 1) * 9)
        const shown = smooth(0.92, 1, draw)
        p.tipMat.color.copy(COL.ice).multiplyScalar(2.6 + hit * 3 + surge * 2)
        const grow = shown * (1 + hit * 0.2)
        p.tip.scale.set(grow, grow, grow * TIP_FLAT)
        // a tight glow (bloom does the rest): a wide sprite reads as an out-of-focus blob
        p.glow.scale.setScalar((0.5 + hit * 0.45 + surge * 0.3) * shown)
        p.glowMat.opacity = (0.32 + hit * 0.55) * shown * e
      })
    },
    dispose() {
      geos.forEach((g) => g.dispose())
      mats.forEach((m) => m.dispose())
    },
  }
}

// ---- the flow lines: trades in, fee split out ---------------------------------------------------

function buildFlow(slices) {
  const group = new THREE.Group()
  const geos = []
  const mats = []
  const line = (curve, { color, core, len, base = 0.05 }) => {
    const c = lineMaterial({ color, base, gain: 9, len, soft: 0.3, white: 0.85 })
    const h = lineMaterial({ color, base: base * 0.4, gain: 1.4, len, soft: 2 })
    mats.push(c, h)
    const g1 = new THREE.TubeGeometry(curve, 140, core, 8, false)
    const g2 = new THREE.TubeGeometry(curve, 140, core * 4.5, 8, false)
    geos.push(g1, g2)
    group.add(new THREE.Mesh(g1, c), new THREE.Mesh(g2, h))
    return { curve, mats: [c, h], len }
  }
  const trades = tradeCurves().map((curve) =>
    line(curve, { color: '#eef1ff', core: 0.02, len: 0.5, base: 0 }),
  )
  const [holders, burn] = slices
  const splits = [
    line(splitCurve(holders.mid, holders.depth), {
      color: '#12C26E',
      core: 0.026,
      len: 0.42,
      base: 0.03,
    }),
    line(splitCurve(burn.mid, burn.depth), {
      color: '#FF3EA5',
      core: 0.022,
      len: 0.42,
      base: 0.03,
    }),
  ]
  const land = splits.map((s) => s.curve.getPointAt(0.93))
  // a pulse's head reaches the line's end `travel` seconds after it starts (its tail follows)
  const head = (tau, start, travel) => (tau < 0 ? -9 : (tau - start) / travel)
  const state = { heads: [], splitHeads: [] }
  return {
    group,
    land,
    update({ tau, e }) {
      trades.forEach((l, j) => {
        const h = head(tau, BEATS.tradeStarts[j], BEATS.tradeTravel)
        state.heads[j] = h
        for (const m of l.mats) {
          m.uniforms.uHeads.value.x = h
          m.uniforms.uOpacity.value = e
        }
      })
      const outs = [BEATS.holdersOut, BEATS.burnOut]
      splits.forEach((l, j) => {
        // a short stream of three pulses, so the share reads as flowing, not a single blip
        const h = head(tau, outs[j], BEATS.splitTravel)
        state.splitHeads[j] = h
        for (const m of l.mats) {
          m.uniforms.uHeads.value.set(h, h > 0.3 ? h - 0.3 : -9, h > 0.6 ? h - 0.6 : -9)
          m.uniforms.uOpacity.value = e
        }
      })
    },
    /** bright sparks at the heads, so the pulses read as light travelling */
    emit(pool, tau) {
      if (tau < 0) return
      const p = TMP
      trades.forEach((l, j) => {
        const h = state.heads[j]
        if (h < 0 || h > 1) return
        for (let k = 0; k < 5; k++) {
          const hk = h - k * 0.03
          if (hk < 0) break
          l.curve.getPointAt(hk, p)
          pool.push(
            p.x,
            p.y,
            p.z,
            k ? COL.ice : COL.white,
            k ? 2.5 : 5,
            1 - k * 0.18,
            k ? 0.04 : 0.09,
          )
        }
      })
      const cols = [COL.greenHi, COL.pinkHi]
      splits.forEach((l, j) => {
        const h = state.splitHeads[j]
        if (h < 0 || h > 1) return
        for (let k = 0; k < 6; k++) {
          const hk = h - k * 0.025
          if (hk < 0) continue
          l.curve.getPointAt(hk, p)
          const j1 = (hash(k * 7 + j) - 0.5) * 0.08
          pool.push(p.x + j1, p.y + j1, p.z - j1, cols[j], k ? 3 : 6, 1 - k * 0.14, k ? 0.05 : 0.11)
        }
      })
    },
    dispose() {
      geos.forEach((g) => g.dispose())
      mats.forEach((m) => m.dispose())
    },
  }
}

// ---- the hub: where the 7% gathers --------------------------------------------------------------

function buildHub() {
  const group = new THREE.Group()
  group.position.copy(HUB)
  const sprite = (color, opacity) =>
    new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: dotTexture(),
        color: color.clone(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        transparent: true,
        opacity,
      }),
    )
  const core = sprite(COL.white, 1)
  const halo = sprite(COL.lavender, 0.5)
  const ringGeo = new THREE.RingGeometry(0.96, 1, 128)
  const ringMat = new THREE.MeshBasicMaterial({
    color: COL.ice.clone().multiplyScalar(2),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  // the fee's shockwave rolls out over the tops of the slices
  const shock = new THREE.Mesh(ringGeo, ringMat)
  shock.rotation.x = -Math.PI / 2
  shock.position.y = 0.62
  group.add(halo, core, shock)
  return {
    group,
    update({ tau, t, e }) {
      let glow = 0.5 + Math.sin(t * 2.1) * 0.08
      if (tau >= 0) {
        BEATS.tradeStarts.forEach((s) => {
          glow += flash(tau - s - BEATS.tradeTravel, 5) * 0.7
        })
      }
      const fee = tau >= 0 ? flash(tau - BEATS.fee, 2.2, 0.12) : 0
      glow += fee * 2.4
      core.scale.setScalar(0.36 + glow * 0.24)
      core.material.color.copy(COL.white).multiplyScalar(1.4 + glow * 2.2)
      core.material.opacity = e
      halo.scale.setScalar(1.5 + glow * 0.5 + fee * 1.4)
      halo.material.opacity = (0.35 + fee * 0.5) * e
      const x = tau >= 0 ? (tau - BEATS.fee) / 1.15 : -1
      shock.visible = x > 0 && x < 1
      if (shock.visible) {
        // it stays over the glass and is all but gone by the back rim, so it never cuts through
        // the 7% label or the chips standing behind the chart
        shock.scale.setScalar(0.3 + easeOut(x) * 2.05)
        ringMat.opacity = (1 - x) ** 2.6
      }
    },
    /** a few motes circling the hub as the fee flares */
    emit(pool, tau, t) {
      const fee = tau >= 0 ? bump(tau, BEATS.fee - 0.3, BEATS.fee + 1.1) : 0
      if (fee <= 0) return
      for (let k = 0; k < 10; k++) {
        const a = t * (1.6 + hash(k) * 1.2) + k * 0.63
        const r = 0.35 + hash(k + 9) * 0.4
        pool.push(
          HUB.x + Math.cos(a) * r,
          HUB.y + (hash(k + 3) - 0.5) * 0.4,
          HUB.z - Math.sin(a) * r,
          COL.ice,
          3,
          fee,
          0.045,
        )
      }
    },
    dispose() {
      core.material.dispose()
      halo.material.dispose()
      ringGeo.dispose()
      ringMat.dispose()
    },
  }
}

/**
 * Light on the studio floor: a soft cobalt pool under the chart, and a green and a pink pool where
 * light through each slice would fall, which brighten when the slice's stream lands.
 */
function buildPool(slices) {
  const geo = new THREE.PlaneGeometry(1, 1)
  const pools = [
    { color: '#3b57ff', size: 9.2, at: new THREE.Vector3(0, -0.25, 0), base: 0.27 },
    ...slices.map((s) => ({
      color: s.color,
      size: 4.6,
      at: onChart(s.mid, 1.9, -0.24),
      // faint at rest: pink or green light pooled on cobalt reads as violet or teal haze
      base: 0.08,
      land: s.key === 'holders' ? BEATS.holders : BEATS.burn,
    })),
  ].map((p) => {
    const mat = new THREE.MeshBasicMaterial({
      map: dotTexture(),
      color: p.color,
      transparent: true,
      opacity: p.base,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.copy(p.at)
    mesh.rotation.x = -Math.PI / 2
    mesh.scale.setScalar(p.size)
    return { ...p, mat, mesh }
  })
  const group = new THREE.Group()
  pools.forEach((p) => group.add(p.mesh))
  return {
    mesh: group,
    update({ t, tau, e }) {
      pools.forEach((p, i) => {
        const lit = p.land !== undefined && tau >= 0 ? flash(tau - p.land, 1.3, 0.15) : 0
        p.mat.opacity = (p.base + Math.sin(t * 0.7 + i * 2) * 0.04 + lit * 0.34) * e
      })
    },
    dispose() {
      geo.dispose()
      pools.forEach((p) => p.mat.dispose())
    },
  }
}

// ---- SOL out of the holders slice, and ripples where the streams land ---------------------------

/** SOL rising out of the holders slice towards the holders label: bright sparks with tails. */
function emitSol(pool, tau, land, target, count = 14) {
  if (tau < 0) return
  const [c0, c1] = BEATS.coins
  for (let k = 0; k < count; k++) {
    const start = c0 + ((c1 - c0) * k) / (count - 1)
    const x0 = (tau - start) / BEATS.coinFlight
    if (x0 <= 0 || x0 >= 1.2) continue
    SOL_A.set((hash(k) - 0.5) * 0.8, 0.5, (hash(k + 5) - 0.5) * 0.6).add(land)
    SOL_C.set((hash(k + 2) - 0.5) * 0.7, (hash(k + 4) - 0.5) * 0.3, 0).add(target)
    SOL_B.copy(SOL_A).lerp(SOL_C, 0.3)
    SOL_B.y += 0.9 + hash(k + 8) * 0.7
    for (let j = 0; j < 6; j++) {
      const x = x0 - j * 0.035
      if (x <= 0 || x >= 1) continue
      const u = easeOut(x)
      const v = 1 - u
      const fade = smooth(0, 0.1, x) * (1 - smooth(0.75, 1, x))
      pool.push(
        SOL_A.x * v * v + 2 * SOL_B.x * u * v + SOL_C.x * u * u,
        SOL_A.y * v * v + 2 * SOL_B.y * u * v + SOL_C.y * u * u,
        SOL_A.z * v * v + 2 * SOL_B.z * u * v + SOL_C.z * u * u,
        j ? COL.green : COL.greenHi,
        j ? 2.4 : 5,
        fade * (1 - j * 0.16),
        j ? 0.05 - j * 0.005 : 0.085,
      )
    }
  }
}
const SOL_A = new THREE.Vector3()
const SOL_B = new THREE.Vector3()
const SOL_C = new THREE.Vector3()

/** Two rings of light spreading over a slice's top where its stream lands, like a drop in liquid. */
function buildRipples(slices, land) {
  const geo = new THREE.RingGeometry(0.9, 1, 96)
  const sets = slices.map((s, i) => {
    const color = new THREE.Color(s.color).lerp(COL.white, 0.35)
    return [0, 1].map(() => {
      const mat = new THREE.MeshBasicMaterial({
        color: color.clone().multiplyScalar(3),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.rotation.x = -Math.PI / 2
      // on the slice's top, under where the stream enters (slice-local: the rest gap removed)
      mesh.position
        .copy(land[i])
        .sub(sliceRest(s))
        .setY(s.depth + 0.012)
      mesh.visible = false
      return mesh
    })
  })
  return {
    sets,
    update(tau) {
      sets.forEach((pair, i) => {
        const at = i === 0 ? BEATS.holders : BEATS.burn
        pair.forEach((m, j) => {
          const x = tau < 0 ? -1 : (tau - at - j * 0.2) / 1.1
          m.visible = x > 0 && x < 1
          if (!m.visible) return
          m.scale.setScalar(0.06 + easeOut(x) * (0.75 - j * 0.2))
          m.material.opacity = (1 - x) ** 1.6
        })
      })
    },
    dispose() {
      geo.dispose()
      sets.flat().forEach((m) => m.material.dispose())
    },
  }
}

// ---- sparks -------------------------------------------------------------------------------------

/** Faint motes drifting up through the studio, for depth. */
function emitDust(pool, t, e, count) {
  for (let k = 0; k < count; k++) {
    const x = (hash(k) - 0.5) * 12
    const z = -6 + hash(k + 40) * 9
    const span = 5.4
    const y = -1.6 + ((hash(k + 80) * span + t * (0.05 + hash(k + 7) * 0.06)) % span)
    const tw = 0.5 + 0.5 * Math.sin(t * (0.8 + hash(k + 3)) + k)
    const edge = smooth(0, 0.6, y + 1.6) * (1 - smooth(span - 1, span, y + 1.6))
    const col = hash(k + 11) > 0.5 ? COL.ice : COL.lavender
    pool.push(
      x + Math.sin(t * 0.2 + k) * 0.2,
      y,
      z,
      col,
      0.9,
      (0.2 + tw * 0.35) * edge * e,
      0.02 + hash(k + 21) * 0.03,
    )
  }
}

/** Trading activity: motes riding round with the flywheel, clockwise, just off the ring. */
function emitOrbit(pool, t, e, phase, count) {
  const n = Math.round(count * 0.7)
  for (let k = 0; k < n; k++) {
    const speed = 0.25 + hash(k + 60) * 0.35
    const a = hash(k + 61) * Math.PI * 2 - (t * speed + phase * 0.6)
    const r = PIE.ring + (hash(k + 62) - 0.5) * 0.55
    const y = PIE.ringY + (hash(k + 63) - 0.5) * 0.35 + Math.sin(t * 1.3 + k) * 0.04
    const tw = 0.55 + 0.45 * Math.sin(t * (2 + hash(k + 64) * 3) + k * 1.7)
    const col = hash(k + 65) > 0.6 ? COL.ice : COL.lavender
    pool.push(Math.cos(a) * r, y, -Math.sin(a) * r, col, 2.4, tw * e * 0.8, 0.036)
  }
}

/** A burst of sparks where a stream lands. */
function emitBurst(pool, tau, at, land, color, count, seed) {
  const x = tau < 0 ? -1 : (tau - at) / 1.1
  if (x <= 0 || x >= 1) return
  for (let k = 0; k < count; k++) {
    const a = hash(k * 3 + seed) * Math.PI * 2
    const sp = 0.4 + hash(k * 5 + seed) * 0.8
    const up = 0.5 + hash(k * 7 + seed) * 0.9
    const d = easeOut(x) * sp
    pool.push(
      land.x + Math.cos(a) * d,
      land.y + 0.42 + up * x - 0.7 * x * x,
      land.z - Math.sin(a) * d,
      color,
      3.2,
      (1 - x) ** 1.4,
      0.05 * (1 - x * 0.5),
    )
  }
}

/** Embers off the burn slice: they flicker, rise a little and go out (supply burned). */
function emitEmbers(pool, tau, t, slice, count = 46) {
  if (tau < 0) return
  const [e0, e1] = BEATS.embers
  const life = 1.8
  for (let k = 0; k < count; k++) {
    const born = e0 + (e1 - e0 - life * 0.5) * hash(k + 101)
    const x = (tau - born) / life
    if (x <= 0 || x >= 1) continue
    const a = slice.start + 0.15 + (slice.end - slice.start - 0.3) * hash(k + 13)
    const r = PIE.inner + 0.25 + (PIE.outer - PIE.inner - 0.45) * hash(k + 17)
    const flicker =
      0.55 + 0.45 * Math.sin(t * (18 + hash(k) * 14) + k * 7.1) * Math.sin(t * 9.3 + k * 3.3)
    EMBER.copy(COL.white)
      .lerp(COL.pinkHi, smooth(0, 0.2, x))
      .lerp(COL.pink, smooth(0.25, 0.9, x))
    pool.push(
      Math.cos(a) * r + Math.sin(t * 2 + k) * 0.08 * x,
      slice.depth + 0.05 + x * (0.6 + hash(k + 31) * 0.9),
      -Math.sin(a) * r + Math.cos(t * 1.7 + k) * 0.08 * x,
      EMBER,
      3 + flicker * 3,
      smooth(0, 0.06, x) * (1 - x) ** 1.1 * flicker,
      0.045 + (1 - x) * 0.04,
    )
  }
}
