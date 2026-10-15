// The space the machine runs in: a polar grid on the floor centred on the flywheel (so the holders
// and the burn rig sit on the same wheel), soft cobalt pools of light under each part, and fine
// dust that gives the camera's moves depth.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { HOLDERS, SUPPLY } from '../layout.js'
import { rand } from '../../anim.js'
import { makeSprites, hdr } from './fx.js'

export const FLOOR_Y = -0.66

const GRID_FRAG = /* glsl */ `
  uniform float uOn;
  uniform vec3 uColor;
  uniform vec3 uPools[3];
  uniform float uPoolR[3];
  varying vec3 vWorld;
  float line(float x, float w) {
    float d = abs(fract(x - 0.5) - 0.5) / fwidth(x);
    return 1.0 - smoothstep(w - 0.5, w + 0.5, d);
  }
  void main() {
    vec2 p = vWorld.xz;
    float r = length(p);
    float th = atan(p.y, p.x);
    float rings = line(r / 1.2, 0.6);
    float spokes = line(th / 6.2831853 * 48.0, 0.5) * smoothstep(3.0, 4.5, r);
    float grid = max(rings, spokes) * smoothstep(30.0, 6.0, r) * 0.32;
    float pool = 0.0;
    for (int i = 0; i < 3; i++) {
      float d = length(vWorld.xz - uPools[i].xz) / uPoolR[i];
      pool += exp(-d * d * 2.2) * (i == 0 ? 0.55 : 0.32);
    }
    gl_FragColor = vec4(uColor * (grid + pool) * uOn, 1.0);
  }
`
const GRID_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

export function Floor({ on = 1 }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: GRID_VERT,
        fragmentShader: GRID_FRAG,
        uniforms: {
          uOn: { value: 1 },
          uColor: { value: new THREE.Color('#3b57ff') },
          uPools: { value: [new THREE.Vector3(0, 0, 0), HOLDERS.center.clone(), SUPPLY.base.clone()] },
          uPoolR: { value: [4.2, 3.6, 3.0] },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  material.uniforms.uOn.value = on
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={FLOOR_Y} material={material}>
      <circleGeometry args={[34, 96]} />
    </mesh>
  )
}

const DUST = 900

export function Dust({ t }) {
  const pool = useMemo(() => makeSprites(DUST, { hardness: 2.5 }), [])
  const seeds = useMemo(
    () =>
      Array.from({ length: DUST }, (_, i) => ({
        p: new THREE.Vector3((rand(i * 5) - 0.5) * 44, -0.4 + rand(i * 5 + 1) * 13, (rand(i * 5 + 2) - 0.5) * 44),
        s: 0.025 + 0.05 * rand(i * 5 + 3) ** 2,
        ph: rand(i * 5 + 4) * 6.28,
        c: rand(i * 5 + 4) < 0.85 ? hdr('#b8c6ff', 1.6) : hdr('#ffffff', 2.4),
      })),
    [],
  )
  useLayoutEffect(() => {
    const tmp = new THREE.Vector3()
    seeds.forEach((d, i) => {
      tmp.set(d.p.x + Math.sin(t * 0.21 + d.ph) * 0.35, d.p.y + Math.sin(t * 0.33 + d.ph * 2) * 0.25 + t * 0.03, d.p.z + Math.cos(t * 0.17 + d.ph) * 0.35)
      const tw = 0.55 + 0.45 * Math.sin(t * 1.7 + d.ph * 3)
      pool.set(i, tmp, d.s, d.c, 0.5 * tw)
    })
    pool.commit()
  }, [t, pool, seeds])
  return <primitive object={pool.points} />
}
