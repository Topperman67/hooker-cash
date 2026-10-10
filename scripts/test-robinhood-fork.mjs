import { spawnSync } from 'node:child_process'
import { network } from '../shared/network.mjs'
const result = spawnSync(
  process.execPath,
  ['node_modules/hardhat/internal/cli/cli.js', 'test', 'test/robinhood-fork.cjs'],
  {
    cwd: new URL('../contracts/protocol/', import.meta.url),
    env: {
      ...process.env,
      HOOKBREW_FORK_RPC_URL: process.env.HOOKBREW_FORK_RPC_URL || network.rpcUrl,
      HOOKBREW_TEST_CHAIN_ID: '4663',
    },
    stdio: 'inherit',
    windowsHide: true,
  },
)
process.exitCode = result.status ?? 1
