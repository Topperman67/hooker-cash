// Robinhood Chain mainnet. Monetary values cross JSON boundaries as integer strings.
export const network = Object.freeze({
  chainId: 4663,
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  nativeSymbol: 'ETH',
  quote: '0x0000000000000000000000000000000000000000',
  quoteSymbol: 'ETH',
  quoteDecimals: 18,
  quoteIsNative: true,
  launchFee: '100000000000000',
  minMcap: '500000000000000000',
  maxMcap: '5000000000000000000',
  defaultMcap: '1000000000000000000',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  create2: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
})
export const protocolVersion = 'hookbrew-v2'
export const modularVersion = 'hookbrew-modular-v2'
export const storageNamespace = 'hookbrew:4663:v2'
export const storageDirectory = '4663-v2'
export const compilerSettings = Object.freeze({
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
  evmVersion: 'cancun',
})
export const treasury = '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4'

export function hasNativeConfiguration(record, expected = network) {
  return (
    !!record &&
    [
      'quote',
      'quoteSymbol',
      'quoteDecimals',
      'quoteIsNative',
      'launchFee',
      'minMcap',
      'maxMcap',
      'defaultMcap',
    ].every((field) => record[field] === expected[field])
  )
}
