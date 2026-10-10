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
          ? '36, 40, 37'
          : tone === 'green'
            ? '52, 65, 38'
            : tone === 'cyan'
              ? '64, 114, 81'
              : '30, 33, 31',
      tintOpacity: tone === 'neutral' ? 0.08 : 0.1,
      refractionStrength: variant === 'clear' ? 32 : variant === 'panel' ? 12 : 5,
      bezelWidth: variant === 'clear' ? 24 : variant === 'panel' ? 14 : 5,
      chromaticAberration: variant === 'clear' ? 0.24 : 0.06,
      edgeHighlight: variant === 'clear' ? 0.5 : 0.16,
      specularStrength: variant === 'clear' ? 0.15 : 0.04,
      elevation: variant === 'panel' ? 0.5 : 0.15,
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
