import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { LiquidGlassEngine } from 'quick-liquid/core'
import { useTheme } from '../lib/theme.js'

// Real liquid-glass lensing (SVG backdrop refraction in Chromium, frosted fallback elsewhere) for
// the few surfaces that deserve it. React owns the content; QuickLiquid owns only its lens layers.
// Chromatic dispersion stays near zero: the brand never shows rainbow fringes.
const PRESETS = {
  bar: {
    material: 'regular',
    blur: 16,
    refractionStrength: 14,
    bezelWidth: 16,
    // The sticky header also floats over the graphite chart and trades: enough frost that its
    // links stay readable there.
    tintOpacity: 0.62,
    quality: 'medium',
  },
  panel: {
    material: 'regular',
    blur: 18,
    refractionStrength: 12,
    bezelWidth: 18,
    tintOpacity: 0.42,
    quality: 'medium',
  },
  pill: {
    material: 'thin',
    blur: 8,
    refractionStrength: 10,
    bezelWidth: 10,
    tintOpacity: 0.5,
    quality: 'low',
  },
  lens: {
    material: 'clear',
    blur: 2,
    refractionStrength: 26,
    bezelWidth: 24,
    tintOpacity: 0.12,
    quality: 'high',
  },
  smoke: {
    material: 'thick',
    blur: 22,
    refractionStrength: 10,
    bezelWidth: 16,
    tintOpacity: 0.8,
    quality: 'medium',
  },
}

// Dark-tint strength per lens at night: the header still floats over graphite instruments, so it
// keeps the most body.
const NIGHT_TINT = { bar: 0.66, panel: 0.5, pill: 0.5, lens: 0.16 }

export default function Glass({
  as: Component = 'div',
  children,
  className = '',
  variant = 'panel',
  radius,
  interactive = false,
  ...props
}) {
  const element = useRef(null)
  const engine = useRef(null)
  const [theme] = useTheme()
  const config = useMemo(() => {
    const preset = PRESETS[variant] || PRESETS.panel
    // Smoke is dark glass in both themes; at night every other lens turns to smoked glass too,
    // with a dimmer white rim so it does not glare against the black studio.
    const dark = variant === 'smoke' || theme === 'dark'
    const night = theme === 'dark' && variant !== 'smoke'
    return {
      ...preset,
      tintOpacity: night ? (NIGHT_TINT[variant] ?? preset.tintOpacity) : preset.tintOpacity,
      appearance: dark ? 'dark' : 'light',
      tint: night ? '14, 17, 23' : dark ? '24, 27, 33' : '255, 255, 255',
      borderRadius: radius ?? (variant === 'pill' ? 999 : variant === 'bar' ? 22 : 20),
      saturation: night ? 1.5 : 1.6,
      chromaticAberration: 0.02,
      dispersionMode: 'auto',
      edgeHighlight: night ? 0.6 : dark ? 0.35 : 0.75,
      specularStrength: night ? 0.2 : dark ? 0.12 : 0.22,
      lightAngle: -45,
      elevation: variant === 'pill' ? 0.4 : 0.8,
      dynamicLighting: interactive,
      hoverLighting: interactive,
      refractionMode: 'auto',
    }
  }, [variant, radius, interactive, theme])

  useEffect(() => {
    const glass = new LiquidGlassEngine(element.current, config)
    engine.current = glass
    return () => {
      glass.destroy()
      engine.current = null
    }
    // Config changes update the existing lens without remounting the surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Component])

  // A layout effect: a theme switch restyles the lens in the same commit, so the view transition
  // (ThemeToggle) captures the header already in its new glass.
  useLayoutEffect(() => {
    engine.current?.setConfig(config)
  }, [config])

  useEffect(() => {
    const glass = engine.current
    if (interactive) glass?.enableLiquidPress({ scale: 0.985, squish: 0.01 })
    return () => glass?.disableLiquidPress()
  }, [interactive, Component])

  const Content =
    Component === 'button' || Component === 'a' || typeof Component !== 'string' ? 'span' : 'div'
  return (
    <Component ref={element} className={`lg lg-${variant} ${className}`} {...props}>
      <Content className="ql-content">{children}</Content>
    </Component>
  )
}
