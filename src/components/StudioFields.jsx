import { Children, cloneElement, isValidElement, useId } from 'react'

export function Field({ label, hint, children }) {
  const id = useId()
  return (
    <div className="studio-field">
      <span id={id}>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) && ['input', 'textarea', 'select'].includes(child.type)
          ? cloneElement(child, {
              'aria-labelledby': child.props['aria-label'] ? undefined : id,
              'aria-describedby': hint ? `${id}-hint` : undefined,
            })
          : child,
      )}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  )
}
export function Metric({ label, value }) {
  return (
    <div className="product-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
