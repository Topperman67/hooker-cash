// Light for the hero scene, drawn without post-processing so the canvas can stay transparent over
// the page: lines of light (the fee beam, the hook lines, the raking lines) and the soft pools of
// studio light behind the glass.
//
// A line is a camera-facing ribbon along a cubic Bézier whose control points are uniforms, so a
// line can follow the swaying Q every frame without rebuilding geometry. The shader paints a crisp
// core, a soft halo and a travelling pulse. Output is premultiplied: `add` 0 blends like paint (a
// crisp coloured line on the pearl page), 1 adds light (a glowing line in the night studio).
import * as THREE from 'three'

const shared = /* glsl */ `
// premultiplied: straight colour c with coverage a, plus a share of it added as light
vec4 emit(vec3 c, float a, float add) {
  vec3 o = linearToOutputTexel(vec4(c, 1.0)).rgb;
  return vec4(o * a, a * (1.0 - add));
}
`

const RAY_VERTEX = /* glsl */ `
uniform vec3 uP[4];
uniform float uWidth;
attribute float aT;
attribute float aSide;
varying float vT;
varying float vSide;
vec3 bez(float t) {
  float u = 1.0 - t;
  return u * u * u * uP[0] + 3.0 * u * u * t * uP[1] + 3.0 * u * t * t * uP[2] + t * t * t * uP[3];
}
vec3 bezTangent(float t) {
  float u = 1.0 - t;
  return 3.0 * u * u * (uP[1] - uP[0]) + 6.0 * u * t * (uP[2] - uP[1]) + 3.0 * t * t * (uP[3] - uP[2]);
}
void main() {
  vec4 mv = modelViewMatrix * vec4(bez(aT), 1.0);
  vec3 tangent = normalize((modelViewMatrix * vec4(bezTangent(aT) + vec3(1e-5, 0.0, 0.0), 0.0)).xyz);
  vec3 side = normalize(cross(tangent, normalize(-mv.xyz)));
  mv.xyz += side * aSide * uWidth;
  gl_Position = projectionMatrix * mv;
  vT = aT;
  vSide = aSide;
}
`

const RAY_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uEdge;
uniform float uCore;
uniform float uGlow;
uniform float uHot;
uniform float uPulseHot;
uniform float uHalo;
uniform float uHead;
uniform float uPulse;
uniform float uTail;
uniform vec2 uFade;
uniform float uOpacity;
uniform float uAdd;
uniform float uTime;
uniform float uFlow;
uniform float uBase;
varying float vT;
varying float vSide;
${shared}
void main() {
  float d = abs(vSide);
  float u = vT - uHead;
  // the pulse: a bright head with a fading trail behind it
  float pulse = uPulse * (u < 0.0 ? exp(u / uTail) : exp(-u * u / 0.00025));
  float core = exp(-d * d / (uCore * uCore * (1.0 + pulse * 1.6)));
  float halo = exp(-d * d * 5.0) * (1.0 - d) * uHalo * (1.0 + pulse * 2.0);
  // light drifting along the line
  float flow = 1.0 + uFlow * sin(vT * 38.0 - uTime * 5.0);
  vec3 hot = mix(uColor, vec3(1.0), clamp(uHot + pulse * uPulseHot, 0.0, 1.0)) * uGlow * flow * (1.0 + pulse * 2.0);
  float a = core + halo * (1.0 - core);
  vec3 c = (hot * core + uEdge * halo * (1.0 - core)) / max(a, 1e-4);
  float ends = smoothstep(0.0, uFade.x, vT) * (1.0 - smoothstep(1.0 - uFade.y, 1.0, vT));
  // a line can rest faint and come up to full strength only where its pulse is
  float lit = mix(uBase, 1.0, clamp(pulse * 1.4, 0.0, 1.0));
  gl_FragColor = emit(c, clamp(a, 0.0, 1.0) * ends * uOpacity * lit, uAdd);
}
`

/** The ribbon every line is drawn on: `segments` steps along t, two vertices across. */
export function rayGeometry(segments = 160) {
  const g = new THREE.BufferGeometry()
  const n = (segments + 1) * 2
  const t = new Float32Array(n)
  const side = new Float32Array(n)
  const index = []
  for (let i = 0; i <= segments; i++) {
    t[i * 2] = t[i * 2 + 1] = i / segments
    side[i * 2] = -1
    side[i * 2 + 1] = 1
    if (i < segments) {
      const a = i * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1))
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  g.setIndex(index)
  return g
}

/** A line of light. Set the curve with `material.uniforms.uP.value[i].copy(...)` each frame. */
export function rayMaterial({
  color = '#ffffff',
  edge = color,
  width = 0.05,
  core = 0.22,
  glow = 1,
  hot = 0.25,
  halo = 0.3,
  tail = 0.12,
  fade = [0.04, 0.04],
  add = 0,
  flow = 0,
  base = 1,
} = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uP: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      uWidth: { value: width },
      uColor: { value: new THREE.Color(color) },
      uEdge: { value: new THREE.Color(edge) },
      uCore: { value: core },
      uGlow: { value: glow },
      uHot: { value: hot },
      uPulseHot: { value: 0.7 },
      uHalo: { value: halo },
      uHead: { value: -1 },
      uPulse: { value: 0 },
      uTail: { value: tail },
      uFade: { value: new THREE.Vector2(...fade) },
      uOpacity: { value: 1 },
      uAdd: { value: add },
      uTime: { value: 0 },
      uFlow: { value: flow },
      uBase: { value: base },
    },
    vertexShader: RAY_VERTEX,
    fragmentShader: RAY_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  })
}

const POOL_FRAGMENT = /* glsl */ `
uniform vec2 uRes;
uniform vec4 uPool[6];
uniform vec3 uPoolColor[6];
uniform vec2 uEdgeFade;
uniform float uAdd;
varying vec2 vUv;
${shared}
void main() {
  vec2 px = vUv * uRes;
  vec3 c = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < 6; i++) {
    float r = length(px - uPool[i].xy) / max(uPool[i].z, 1.0);
    float k = uPool[i].w * exp(-r * r * 2.2);
    // paint each pool over the ones before it
    c = mix(c, uPoolColor[i], k / max(a + k * (1.0 - a), 1e-4));
    a = a + k * (1.0 - a);
  }
  // fade to nothing well before the canvas edge, so the canvas never shows its rectangle
  vec2 e = clamp(min(px, uRes - px) / uEdgeFade, 0.0, 1.0);
  a *= smoothstep(0.0, 1.0, e.x) * smoothstep(0.0, 1.0, e.y);
  gl_FragColor = emit(c, clamp(a, 0.0, 1.0), uAdd);
}
`

/** Soft pools of studio light on a plane that fills the view at its depth. */
export function poolMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRes: { value: new THREE.Vector2(1, 1) },
      uPool: { value: [...Array(6)].map(() => new THREE.Vector4()) },
      uPoolColor: { value: [...Array(6)].map(() => new THREE.Color()) },
      uEdgeFade: { value: new THREE.Vector2(60, 60) },
      uAdd: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: POOL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  })
}
