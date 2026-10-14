// Use the headless Chromium Playwright already installed on this machine when there is one
// (REMOTION_BROWSER overrides); otherwise Remotion downloads its own.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

function playwrightShell() {
  const dir = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (!existsSync(dir)) return null
  const shells = readdirSync(dir)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
  for (const d of shells) {
    const exe = path.join(dir, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

export const browserExecutable = process.env.REMOTION_BROWSER || playwrightShell()
