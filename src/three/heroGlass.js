// Liquid glass for the hero Q: drei's MeshTransmissionMaterial approach (MeshPhysicalMaterial with
// three's transmission swapped for screen-space refraction of a supplied buffer), made liquid. A
// height field travels through the glass: slow flow waves always, plus wave packets that ring out
// from where the fee pulse strikes. It displaces the vertices and, per pixel, bends the normals by
// its analytic gradient, so refraction, reflections and the clearcoat all ripple together. A strip
// light sweeps the surface, the pointer adds a glint, and the pulse lights the glass from inside.
//
// The buffer is shared: HeroScene renders the scene behind the glass once per frame and every
// piece samples that, instead of each material rendering the scene again into its own target.
import * as THREE from 'three'

// The surface field in the mark's own units (SVG units; the Q spans about ±230). Returns the
// height's gradient in xyz and the height in w.
const FIELD = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uRipple;
uniform vec4 uImpact[2];
varying vec3 vObj;

vec4 flowWave(vec3 p, vec3 k, float a, float w) {
  float ph = dot(p, k) - w * uTime;
  return vec4(a * cos(ph) * k, a * sin(ph));
}

vec4 packet(vec3 p, vec4 imp) {
  if (imp.w < 0.0) return vec4(0.0);
  vec3 d = p - imp.xyz;
  float r = length(d) + 1e-3;
  float u = r - 250.0 * imp.w;
  const float k = 0.085;
  const float s2 = 3600.0;
  float env = uRipple * exp(-imp.w * 1.6) * exp(-u * u / s2);
  float dh = env * (k * cos(k * u) - 2.0 * u / s2 * sin(k * u));
  return vec4(dh * d / r, env * sin(k * u));
}

vec4 liquid(vec3 p) {
  vec4 f = uFlow * (
    flowWave(p, vec3(0.020, 0.012, 0.006), 1.7, LIQUID_W1) +
    flowWave(p, vec3(-0.010, 0.022, -0.008), 1.5, LIQUID_W2) +
    flowWave(p, vec3(0.030, -0.026, 0.012), 0.8, LIQUID_W3)
  );
  return f + packet(p, uImpact[0]) + packet(p, uImpact[1]);
}
`

const glsl = (n) => n.toFixed(6)

export class LiquidGlassMaterial extends THREE.MeshPhysicalMaterial {
  /**
   * @param {object} o
   * @param {number} o.samples refraction samples (compiled in)
   * @param {number} o.loop seconds: the flow waves repeat exactly once per loop
   * @param {boolean} o.liquid ripple, sweep and glow (off for the small droplets)
   */
  constructor({ samples = 6, loop = 7.2, liquid = true, ...params } = {}) {
    super()
    this.uniforms = {
      chromaticAberration: { value: 0.04 },
      transmission: { value: 0 },
      _transmission: { value: 1 },
      roughness: { value: 0 },
      thickness: { value: 0 },
      attenuationDistance: { value: Infinity },
      attenuationColor: { value: new THREE.Color('white') },
      anisotropicBlur: { value: 0.1 },
      buffer: { value: null },
      uTime: { value: 0 },
      uFlow: { value: 1 },
      uRipple: { value: 0 },
      uImpact: { value: [new THREE.Vector4(0, 0, 0, -1), new THREE.Vector4(0, 0, 0, -1)] },
      uSweep: { value: new THREE.Vector3(-9, 0.09, 0) },
      uPointer: { value: new THREE.Vector4(0, 0, 1, 0) },
      uGlow: { value: new THREE.Vector4(0, 0, 0, 0) },
      uGlowColor: { value: new THREE.Color('#ffffff') },
      // x: how dark steep bevels go, y..z: the grazing range they darken over, w: face lift
      uFlag: { value: new THREE.Vector4(0, 0.4, 0.9, 1) },
      uFlagColor: { value: new THREE.Color('#15181d') },
    }
    const w = (n) => glsl((2 * Math.PI * n) / loop)
    const defines = `#define LIQUID_W1 ${w(2)}\n#define LIQUID_W2 ${w(3)}\n#define LIQUID_W3 ${w(-4)}\n`
    this.onBeforeCompile = (shader) => {
      shader.uniforms = { ...shader.uniforms, ...this.uniforms }
      shader.defines.USE_TRANSMISSION = ''
      if (liquid) shader.defines.LIQUID = ''

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${defines}${FIELD}`)
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
          vObj = position;
          #ifdef LIQUID
            // along a direction that depends on position alone: creased normals are split per
            // face, and pushing along them would open cracks at every crease
            transformed += normalize(vec3(position.xy * 0.006, position.z * 0.03)) * liquid(position).w;
          #endif`,
        )

      shader.fragmentShader = `${defines}${FIELD}
        uniform mat4 modelMatrix;
        uniform float chromaticAberration;
        uniform float anisotropicBlur;
        uniform sampler2D buffer;
        uniform vec3 uSweep;
        uniform vec4 uPointer;
        uniform vec4 uGlow;
        uniform vec3 uGlowColor;
        uniform vec4 uFlag;
        uniform vec3 uFlagColor;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        // the field's slope as a view-space vector, for bending normals
        vec3 liquidSlope() {
          vec3 g = liquid(vObj).xyz;
          vec3 gw = mat3(modelMatrix) * g / max(length(modelMatrix[0].xyz), 1e-6);
          return mat3(viewMatrix) * gw;
        }
        vec3 bend(vec3 n, vec3 g) {
          #ifdef FLIP_SIDED
            g = -g;
          #endif
          return normalize(n - (g - n * dot(n, g)));
        }
        ${shader.fragmentShader}`

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <transmission_pars_fragment>', TRANSMISSION_PARS)
        .replace('#include <transmission_fragment>', transmissionFragment(samples))
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
          #ifdef LIQUID
            vec3 liquidG = liquidSlope();
            normal = bend(normal, liquidG);
          #endif`,
        )
        .replace(
          '#include <clearcoat_normal_fragment_begin>',
          /* glsl */ `#include <clearcoat_normal_fragment_begin>
          #if defined( LIQUID ) && defined( USE_CLEARCOAT )
            clearcoatNormal = bend(clearcoatNormal, liquidG);
          #endif`,
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `#ifdef LIQUID
            {
              vec3 V = normalize(vViewPosition);
              vec3 R = reflect(-V, normal);
              // a band of light gliding over the mark the way the fees flow (counter to tail),
              // caught by the curved bevels and barely by the faces, so the glass stays clear
              float rim = pow(1.0 - saturate(dot(normal, V)), 2.5);
              float b = dot(vObj.xy, vec2(0.7071, -0.7071)) / 230.0 - uSweep.x;
              float band = exp(-b * b / (uSweep.y * uSweep.y));
              outgoingLight += vec3(uSweep.z * band * (0.04 + 0.96 * rim));
              // the pointer is the studio light
              outgoingLight += vec3(uPointer.w * pow(saturate(dot(R, uPointer.xyz)), 260.0));
              // the fee pulse, lighting the glass from inside as it crosses
              vec3 gd = vObj - uGlow.xyz;
              outgoingLight += uGlowColor * (uGlow.w * exp(-dot(gd, gd) / 5200.0));
            }
          #endif
          #include <opaque_fragment>`,
        )
    }
    // three keys compiled programs on this string, so variants never share a program
    this.customProgramCacheKey = () => `liquid-glass:${samples}:${liquid}:${loop}`
    // The transmission uniforms shadow MeshPhysicalMaterial's own fields; `transmission` stays 0
    // so three never runs its own transmission pass.
    for (const name of Object.keys(this.uniforms)) {
      Object.defineProperty(this, name, {
        get: () => this.uniforms[name].value,
        set: (v) => (this.uniforms[name].value = v),
      })
    }
    this.setValues(params)
  }
}

const TRANSMISSION_PARS = /* glsl */ `
#ifdef USE_TRANSMISSION
  uniform float _transmission;
  uniform float thickness;
  uniform float attenuationDistance;
  uniform vec3 attenuationColor;
  uniform mat4 projectionMatrix;
  varying vec3 vWorldPosition;
  vec3 getVolumeTransmissionRay(const in vec3 n, const in vec3 v, const in float thickness,
      const in float ior, const in vec3 modelScale) {
    // past the critical angle refract() returns zero (total internal reflection): go straight
    vec3 r = refract(-v, n, 1.0 / ior);
    r = dot(r, r) > 1e-8 ? normalize(r) : -v;
    return r * thickness * modelScale;
  }
  vec4 getIBLVolumeRefraction(const in vec3 n, const in vec3 v, const in vec3 diffuseColor,
      const in vec3 position, const in vec3 modelScale, const in vec3 attenuationCoefficient,
      const in vec3 F, const in float ior, const in float thickness, const in float attenuationDistance) {
    vec3 ray = getVolumeTransmissionRay(n, v, thickness, ior, modelScale);
    vec4 ndc = projectionMatrix * viewMatrix * vec4(position + ray, 1.0);
    vec2 uv = (ndc.xy / ndc.w + 1.0) * 0.5;
    vec4 seen = texture2D(buffer, uv);
    vec3 c = seen.rgb;
    if (!isinf(attenuationDistance)) c *= exp(-attenuationCoefficient * length(ray));
    return vec4((1.0 - F) * c * diffuseColor, seen.a);
  }
#endif
`

const transmissionFragment = (samples) => /* glsl */ `
material.transmission = _transmission;
material.transmissionAlpha = 1.0;
material.thickness = thickness;
material.attenuationDistance = attenuationDistance;
material.attenuationColor = attenuationColor;
if (material.transmission != 0.0) {
  vec3 pos = vWorldPosition;
  vec3 v = normalize(cameraPosition - pos);
  vec3 n = inverseTransformDirection(normal, viewMatrix);
  vec3 transmission = vec3(0.0);
  float jitter = hash12(gl_FragCoord.xy);
  float smear = thickness * anisotropicBlur;
  vec3 modelScale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz),
    length(modelMatrix[2].xyz));
  vec3 attenuationCoefficient = vec3(0.0);
  if (!isinf(material.attenuationDistance))
    attenuationCoefficient = -log(material.attenuationColor) / material.attenuationDistance;
  vec3 F = EnvironmentBRDF(n, v, material.specularColor, material.specularF90, material.roughness);
  for (float i = 0.0; i < ${samples}.0; i++) {
    float progress = (i + jitter) / ${samples}.0;
    float t = material.thickness + smear * progress;
    float ab = chromaticAberration * progress;
    transmission.r += getIBLVolumeRefraction(n, v, material.diffuseColor, pos, modelScale,
      attenuationCoefficient, F, material.ior, t, material.attenuationDistance).r;
    transmission.g += getIBLVolumeRefraction(n, v, material.diffuseColor, pos, modelScale,
      attenuationCoefficient, F, material.ior * (1.0 + ab), t, material.attenuationDistance).g;
    transmission.b += getIBLVolumeRefraction(n, v, material.diffuseColor, pos, modelScale,
      attenuationCoefficient, F, material.ior * (1.0 + 2.0 * ab), t, material.attenuationDistance).b;
  }
  transmission /= ${samples}.0;
  // Screen-space refraction only sees the page, never the studio around the glass, so a steep
  // bevel on pearl would just show more white. Photographed glass goes dark there, from the black
  // flags beside it: fold that in, so the edges stay defined, and lift the faces back to clear.
  float graze = smoothstep(uFlag.y, uFlag.z, 1.0 - saturate(dot(n, v)));
  transmission *= mix(vec3(uFlag.w), uFlagColor, uFlag.x * graze);
  totalDiffuse = mix(totalDiffuse, transmission, material.transmission);
}
`
