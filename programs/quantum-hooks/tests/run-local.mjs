// Local end-to-end run: (optionally) builds the test program in Docker, starts
// solana-test-validator in Docker with the dumped mainnet pump.fun programs/accounts and
// quantum_hooks, runs the TS tests on the host against it, then stops the validator.
//   node programs/quantum-hooks/tests/run-local.mjs [--build] [--keep] [--fetch] [-- <node --test args>]
// Only the local validator ever receives transactions.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const repo = resolve(workspace, '..', '..')
const image = process.env.ANCHOR_IMAGE || 'solanafoundation/anchor:v0.31.1'
const container = 'quantum-hooks-validator'
const rpc = process.env.QH_RPC || 'http://127.0.0.1:8899'
const argv = process.argv.slice(2)
const passthrough = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : []
const flags = new Set(argv.filter((a) => !passthrough.includes(a)))

function run(cmd, args, opts = {}) {
  const out = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (out.status !== 0 && !opts.allowFail)
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} … exited ${out.status}`)
  return out
}

const wrapper =
  process.platform === 'win32'
    ? [
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(repo, 'scripts', 'anchor-docker.ps1'),
        ],
      ]
    : ['bash', [join(repo, 'scripts', 'anchor-docker.sh')]]

// 1. Fixtures and test build.
const fixtures = join(here, 'fixtures')
if (
  flags.has('--fetch') ||
  !existsSync(join(fixtures, 'programs')) ||
  readdirSync(join(fixtures, 'programs')).length < 4
) {
  run(process.execPath, [join(fixtures, 'fetch-fixtures.mjs')])
}
const testSo = join(workspace, 'target', 'deploy-test', 'quantum_hooks.so')
if (flags.has('--build') || !existsSync(testSo)) run(wrapper[0], [...wrapper[1], 'build-test'])
// The program id the client uses (shared/idl/quantum_hooks.json). The validator loads the test
// build at that address, so no program keypair is needed (it stays out of git; see README).
const programId = new PublicKey(
  JSON.parse(readFileSync(join(repo, 'shared', 'idl', 'quantum_hooks.json'), 'utf8')).address,
)

// 2. Test-only upgrade authority (initialize_config must be signed by it).
const keysDir = join(fixtures, '.keys')
mkdirSync(keysDir, { recursive: true })
const authorityFile = join(keysDir, 'authority.json')
if (!existsSync(authorityFile))
  writeFileSync(authorityFile, JSON.stringify(Array.from(Keypair.generate().secretKey)))
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(authorityFile, 'utf8'))),
)

// 3. Validator.
spawnSync('docker', ['stop', '-t', '2', container], { stdio: 'ignore' })
run('docker', [
  'run',
  '--rm',
  '-d',
  '--name',
  container,
  '-p',
  '127.0.0.1:8899:8899',
  '-p',
  '127.0.0.1:8900:8900',
  '--mount',
  `type=bind,source=${workspace},target=/work/programs/quantum-hooks,readonly`,
  '-w',
  '/work/programs/quantum-hooks',
  image,
  'bash',
  '-c',
  `tr -d '\\r' < scripts/in-container.sh > /tmp/ic.sh && exec bash /tmp/ic.sh validator "$@"`,
  '_',
  programId.toBase58(),
  authority.publicKey.toBase58(),
])

const connection = new Connection(rpc, 'confirmed')
const started = Date.now()
for (;;) {
  try {
    const slot = await connection.getSlot()
    const info = await connection.getAccountInfo(programId)
    if (slot > 2 && info) break
  } catch {}
  if (Date.now() - started > 180_000) {
    run('docker', ['logs', '--tail', '80', container], { allowFail: true })
    spawnSync('docker', ['stop', '-t', '2', container], { stdio: 'ignore' })
    throw new Error('validator did not come up within 180 s')
  }
  await new Promise((r) => setTimeout(r, 1000))
}
console.log(
  `validator up in ${((Date.now() - started) / 1000).toFixed(1)} s; quantum_hooks = ${programId.toBase58()}`,
)

// 4. Tests (sequential: they share one validator).
let status = 1
try {
  const tests = passthrough.length
    ? passthrough
    : [join(here, 'merkle.test.ts'), join(here, 'client.test.ts'), join(here, 'e2e.test.ts')]
  const out = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=spec', ...tests],
    {
      stdio: 'inherit',
      cwd: workspace,
      env: {
        ...process.env,
        QH_RPC: rpc,
        QH_PROGRAM_ID: programId.toBase58(),
        QH_AUTHORITY: authorityFile,
      },
    },
  )
  status = out.status ?? 1
} finally {
  if (!flags.has('--keep')) spawnSync('docker', ['stop', '-t', '2', container], { stdio: 'ignore' })
  else console.log(`validator left running as ${container} (docker stop ${container})`)
}
process.exit(status)
