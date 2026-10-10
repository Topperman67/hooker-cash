import { parseAbi } from 'viem'

// Current Arc V10 interface published by the original project, separately tested
// with read-only calls. This ABI does not establish implementation safety.
export const launchAbi = parseAbi([
  'struct TokenMetadata { string description; string imageURI; string website; string twitter; string telegram; }',
  'struct LaunchConfig { bytes32 vanitySalt; uint256 targetMcap; }',
  'struct Split { address wallet; uint16 bps; uint32 cliffSecs; uint32 durationSecs; }',
  'function launch(string name_, string symbol_, uint256 totalSupply_, uint256 creatorAllocation_, address hook_, uint24 fee_, TokenMetadata meta_, LaunchConfig cfg, address quote_, uint256 quoteAmount_, Split[] split_) payable returns (address token)',
  'function launchFee() view returns (uint256)',
  'function policy() view returns (address)',
  'function treasury() view returns (address)',
  'event TokenLaunched(address indexed token, address indexed creator, address indexed hook, bytes32 poolId, uint24 fee, uint160 sqrtPriceX96, uint256 totalSupply, uint256 creatorAllocation)',
  'event TokenLaunched(address indexed token, address indexed creator, address indexed hook, bytes32 poolId, uint24 fee, uint160 sqrtPriceX96, uint256 totalSupply, uint256 creatorAllocation, uint32 vestingCliffSecs, uint32 vestingDurationSecs)',
])

export const launchPolicyAbi = parseAbi([
  'function treasury() view returns (address)',
  'function allowedQuoteCurrency(address) view returns (bool)',
])
export const launchHookAbi = parseAbi(['function launchedToken(address) view returns (bool)'])
