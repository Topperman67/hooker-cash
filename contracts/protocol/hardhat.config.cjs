require('@nomicfoundation/hardhat-viem')
const { subtask } = require('hardhat/config')
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names')
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _, runSuper) => {
  if (solcVersion !== '0.8.26') return runSuper()
  return { compilerPath: require.resolve('solc/soljson.js'), isSolcJs: true, version: '0.8.26', longVersion: require('solc').version() }
})
module.exports = {
  solidity: { version: '0.8.26', settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' } },
  networks: { hardhat: { chainId: Number(process.env.HOOKBREW_TEST_CHAIN_ID || 31337), allowUnlimitedContractSize: false }, localhost: { url: 'http://127.0.0.1:8545' } },
  mocha: { timeout: 120000 }
}
