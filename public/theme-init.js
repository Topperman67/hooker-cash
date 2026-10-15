// Applies the saved colour theme before first paint, so dark-mode visitors never see a flash of the
// pearl studio. Light is the default. Kept as a tiny external file: the CSP allows no inline
// scripts. Mirrors readTheme/applyTheme in src/lib/theme.js.
;(function () {
  var theme = 'light'
  try {
    if (localStorage.getItem('quantpad:theme') === 'dark') theme = 'dark'
  } catch (e) {}
  var root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  if (theme === 'dark') {
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', '#07080c')
  }
})()
