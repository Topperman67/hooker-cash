// Shaders for the fee flywheel's light: lines that carry pulses, a pool of soft sparks, and the
// card's cobalt backdrop. All of it is additive HDR light (toneMapped off) so the bloom catches it.
import * as THREE from 'three'

const LINE_VERT = /* glsl */ `
  varying float vS;
  varying float vFacing;
  void main() {
    vS = uv.x;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vFacing = abs(dot(n, normalize(cameraPosition - world.xyz)));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

// A tube of light along a curve (uv.x runs along it). It shows a faint track (uBase), up to three
// pulses (uHeads, positions along the line, each with a tail uLen long) and can be drawn on (uDraw).
// uFade softens both ends, so a wide halo tube does not stop in a visible straight cut.
const LINE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBase;
  uniform float uGain;
  uniform vec3 uHeads;
  uniform float uLen;
  uniform float uDraw;
  uniform float uRamp;
  uniform float uSoft;
  uniform float uOpacity;
  uniform float uWhite;
  uniform float uFade;
  varying float vS;
  varying float vFacing;

  float comet(float head) {
    float d = head - vS;
    float tail = step(0.0, d) * pow(clamp(1.0 - d / uLen, 0.0, 1.0), 2.4);
    // min(): exp of a large positive d overflows to Inf, and 0 * Inf is NaN
    float nose = (1.0 - step(0.0, d)) * exp(min(d, 0.0) * 260.0);
    return tail + nose;
  }

  void main() {
    if (vS > uDraw) discard;
    float p = comet(uHeads.x) + comet(uHeads.y) + comet(uHeads.z);
    // a pen tip while the line draws on
    float tip = uDraw < 0.999 ? exp(-(uDraw - vS) * 30.0) : 0.0;
    p += tip * 1.5;
    float ramp = mix(1.0 - uRamp, 1.0, vS);
    float edge = pow(vFacing, uSoft);
    if (uFade > 0.0) edge *= smoothstep(0.0, uFade, vS) * smoothstep(1.0, 1.0 - uFade, vS);
    vec3 c = mix(uColor, vec3(1.0), clamp(p * 0.5, 0.0, uWhite));
    gl_FragColor = vec4(c * (uBase * ramp + uGain * p) * edge * uOpacity, 1.0);
  }
`

/** A light line's material. Core and halo are two tubes with the same uniforms but softer edges. */
export function lineMaterial({
  color,
  base = 1,
  gain = 4,
  len = 0.2,
  ramp = 0,
  soft = 0.4,
  opacity = 1,
  white = 0.7,
  fade = 0,
}) {
  return new THREE.ShaderMaterial({
    vertexShader: LINE_VERT,
    fragmentShader: LINE_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uBase: { value: base },
      uGain: { value: gain },
      uHeads: { value: new THREE.Vector3(-9, -9, -9) },
      uLen: { value: len },
      uDraw: { value: 1 },
      uRamp: { value: ramp },
      uSoft: { value: soft },
      uOpacity: { value: opacity },
      uWhite: { value: white },
      uFade: { value: fade },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
}

const SPARK_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  uniform float uScale;
  varying vec4 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uScale / -mv.z, 0.0, 128.0);
    vColor = aColor;
  }
`
const SPARK_FRAG = /* glsl */ `
  varying vec4 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float glow = pow(1.0 - d, 2.2);
    float core = smoothstep(0.4, 0.0, d);
    vec3 c = vColor.rgb * glow * 0.8 + mix(vColor.rgb, vec3(1.0), 0.5) * core * 1.2;
    gl_FragColor = vec4(c * vColor.a, 1.0);
  }
`

/** Soft round sparks; sizes are in world units (uScale turns them into pixels). */
export function sparkMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    uniforms: { uScale: { value: 400 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
}

/**
 * A pool of sparks the scene refills every frame: push() points, then commit(). Cheaper than
 * one object per spark, and deterministic (positions come from the loop's clock, not a sim).
 */
export class SparkPool {
  constructor(capacity) {
    this.capacity = capacity
    this.count = 0
    this.position = new Float32Array(capacity * 3)
    this.color = new Float32Array(capacity * 4)
    this.size = new Float32Array(capacity)
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage),
    )
    g.setAttribute(
      'aColor',
      new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage),
    )
    g.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
    )
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.geometry = g
    this.material = sparkMaterial()
    this.points = new THREE.Points(g, this.material)
    this.points.frustumCulled = false
  }
  push(x, y, z, color, intensity, alpha, size) {
    if (this.count >= this.capacity || alpha <= 0.002 || size <= 0) return
    const i = this.count++
    this.position[i * 3] = x
    this.position[i * 3 + 1] = y
    this.position[i * 3 + 2] = z
    this.color[i * 4] = color.r * intensity
    this.color[i * 4 + 1] = color.g * intensity
    this.color[i * 4 + 2] = color.b * intensity
    this.color[i * 4 + 3] = alpha
    this.size[i] = size
  }
  commit() {
    const g = this.geometry
    g.setDrawRange(0, this.count)
    for (const name of ['position', 'aColor', 'aSize']) {
      const a = g.attributes[name]
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.count * a.itemSize)
      a.needsUpdate = true
    }
    this.count = 0
  }
  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

const BACKDROP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`
// The card's backdrop, as the ad still paints it: deep #04061a with cobalt glows, composited in
// sRGB like a 2D canvas, then handed to the linear pipeline. uView maps this view (a crop, on narrow
// cards) back onto the full 16:9 frame so the glows stay where the still has them.
const BACKDROP_FRAG = /* glsl */ `
  uniform vec4 uView;
  uniform float uAspect;
  uniform float uTime;
  uniform vec3 uBase;
  uniform vec3 uColors[3];
  uniform vec4 uGlows[3];
  varying vec2 vUv;

  float falloff(float d) {
    return d < 0.45 ? mix(1.0, 0.45, d / 0.45) : mix(0.45, 0.0, clamp((d - 0.45) / 0.55, 0.0, 1.0));
  }
  vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  void main() {
    vec2 uv = uView.xy + vUv * uView.zw;
    vec2 p = vec2(uv.x, 1.0 - uv.y);
    vec3 c = uBase;
    for (int i = 0; i < 3; i++) {
      vec4 g = uGlows[i];
      // the cobalt glow behind the chart breathes, very slowly
      float breathe = i == 1 ? 0.9 + 0.1 * sin(uTime * 0.45) : 1.0;
      vec2 d = vec2((p.x - g.x) * uAspect, p.y - g.y);
      float a = g.w * breathe * falloff(length(d) / (g.z * uAspect));
      c = mix(c, uColors[i], a);
    }
    gl_FragColor = vec4(toLinear(c), 1.0);
  }
`

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)

/** The backdrop: a full-screen triangle drawn first, behind everything. */
export function createBackdrop({ base, glows }) {
  const g = new THREE.BufferGeometry()
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  )
  const m = new THREE.ShaderMaterial({
    vertexShader: BACKDROP_VERT,
    fragmentShader: BACKDROP_FRAG,
    uniforms: {
      uView: { value: new THREE.Vector4(0, 0, 1, 1) },
      uAspect: { value: 16 / 9 },
      uTime: { value: 0 },
      uBase: { value: new THREE.Vector3(...hex(base)) },
      uColors: { value: glows.map((gl) => new THREE.Vector3(...hex(gl.color))) },
      uGlows: { value: glows.map((gl) => new THREE.Vector4(gl.x, gl.y, gl.r, gl.alpha)) },
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(g, m)
  mesh.frustumCulled = false
  mesh.renderOrder = -100
  return mesh
}
