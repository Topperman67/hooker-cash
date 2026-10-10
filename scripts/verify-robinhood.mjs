import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const source = process.argv[2]
if (!source) {
  console.error(
    'Usage: npm run contracts:verify -- https://your-app.example OR deployment-record.json',
  )
  process.exit(1)
}
const result = spawnSync(
  process.execPath,
  [
    'node_modules/hardhat/internal/cli/cli.js',
    'run',
    'scripts/verify-robinhood.cjs',
    '--network',
    'robinhood',
  ],
  {
    cwd: new URL('../contracts/protocol/', import.meta.url),
    env: {
      ...process.env,
      HOOKBREW_VERIFY_SOURCE: source.startsWith('https://') ? source : resolve(source),
    },
    stdio: 'inherit',
    windowsHide: true,
  },
)
process.exitCode = result.status ?? 1
