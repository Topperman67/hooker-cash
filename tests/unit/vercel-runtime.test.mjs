import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

// Vercel's Node runtime is stricter than plain Node 24: it does not guess a .js file's module format
// from its syntax, and its loader refuses require() of an ES module. Dependencies that rely on either
// (an "ESM" build in a plain .js file, a CommonJS package requiring an ESM-only one) work locally and
// crash every request there. Load the API, and the modules it imports lazily, the same way.
test('the API and its lazily loaded modules load under Vercel-like module rules', () => {
  const script = [
    "await import('./api/[[...path]].js')",
    "await import('./server/application.mjs')",
    "const quantum = await import('./shared/quantum.mjs')",
    "await import('./shared/merkle.mjs')",
    "await import('./shared/lookup.mjs')",
    "if (typeof quantum.buildPulseInstructions !== 'function') throw new Error('quantum client incomplete')",
    "console.log('loaded')",
  ].join('; ')
  const run = spawnSync(
    process.execPath,
    [
      '--no-experimental-require-module',
      '--no-experimental-detect-module',
      '--input-type=module',
      '-e',
      script,
    ],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /loaded/)
})
