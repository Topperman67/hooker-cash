// Use the headless Chromium Playwright already installed on this machine when there is one
// (REMOTION_BROWSER overrides); otherwise Remotion downloads its own.
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function playwrightShell() {
  const win = process.platform === 'win32'
  const dirs = win
    ? [path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')]
    : [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean)
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const shells = readdirSync(dir)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
    for (const d of shells) {
      const exe = win
        ? path.join(dir, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
        : path.join(dir, d, 'chrome-linux', 'headless_shell')
      if (existsSync(exe)) return exe
    }
  }
  return null
}

export const browserExecutable = process.env.REMOTION_BROWSER || playwrightShell()

/** GPU WebGL through ANGLE by default; REMOTION_GL=swangle renders on the CPU (no GPU, e.g. CI) */
export const chromiumOptions = { gl: process.env.REMOTION_GL || 'angle' }
