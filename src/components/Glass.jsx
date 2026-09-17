import { useEffect, useMemo, useRef } from 'react'
import { LiquidGlassEngine } from 'quick-liquid/core'

/** React owns the content; QuickLiquid owns only its decorative lens layers. */
export default function Glass({
  as: Component = 'div',
  children,
  className = '',
  variant = 'panel',
  tone = 'neutral',
  radius,
  interactive = false,
  style,
  ...props
}) {
  const element = useRef(null)
  const engine = useRef(null)
  const config = useMemo(
    () => ({
      material: variant === 'clear' ? 'clear' : variant === 'panel' ? 'regular' : 'thin',
      appearance: 'dark',
      borderRadius: radius ?? (variant === 'pill' ? 999 : variant === 'control' ? 14 : 24),
      blur: variant === 'clear' ? 2 : variant === 'panel' ? 12 : 7,
      tint:
        tone === 'slate'
          ? '30, 43, 65'
          : tone === 'violet'
            ? '79, 30, 126'
            : tone === 'cyan'
              ? '61, 135, 152'
              : '55, 25, 83',
      tintOpacity: tone === 'neutral' ? 0.1 : 0.16,
      refractionStrength: variant === 'clear' ? 32 : variant === 'panel' ? 18 : 12,
      bezelWidth: variant === 'panel' || variant === 'clear' ? 24 : 12,
      chromaticAberration: 0.24,
      edgeHighlight: 0.5,
      specularStrength: 0.15,
      elevation: variant === 'panel' ? 1.2 : 0.45,
      quality: variant === 'clear' ? 'high' : variant === 'panel' ? 'medium' : 'low',
      dynamicLighting: interactive,
      refractionMode: 'auto',
    }),
    [variant, radius, tone, interactive],
  )

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

  useEffect(() => {
    engine.current?.setConfig(config)
  }, [config])
  useEffect(() => {
    const glass = engine.current
    if (interactive) glass?.enableLiquidPress({ scale: 0.98, squish: 0.012 })
    return () => glass?.disableLiquidPress()
  }, [interactive, Component])

  const Content =
    Component === 'button' || Component === 'a' || typeof Component !== 'string' ? 'span' : 'div'
  return (
    <Component
      ref={element}
      className={`glass glass-${variant} glass-${tone} ${className}`}
      style={style}
      {...props}
    >
      <Content className="ql-content">{children}</Content>
    </Component>
  )
}
