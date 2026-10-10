import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

// Vercel's Node runtime does not guess a .js file's module format from its syntax, so a dependency
// whose "ESM" build is a plain .js file without "type": "module" loads as CommonJS there and its
// named exports disappear. Load the whole API that way, as the deployed function does.
test('the API loads without module syntax detection, as on Vercel', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--no-experimental-detect-module',
      '--input-type=module',
      '-e',
      "await import('./api/[[...path]].js'); await import('./server/application.mjs'); console.log('loaded')",
    ],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /loaded/)
})
