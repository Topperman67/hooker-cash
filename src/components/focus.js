// Keyboard focus helpers for dialogs.

export const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ')

// Tabbable elements inside `root`, in DOM order, skipping hidden and inert ones.
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden], [inert]') && el.getClientRects().length > 0,
  )
}

// Where Tab (or Shift+Tab when `back`) should move focus to stay inside a dialog. Returns the
// element to focus, or null when the browser's own move already stays inside.
export function trapTarget(items, active, back, container = null) {
  if (!items.length) return container
  const first = items[0]
  const last = items[items.length - 1]
  const index = items.indexOf(active)
  if (index === -1) return back ? last : first
  if (back && index === 0) return last
  if (!back && index === items.length - 1) return first
  return null
}
