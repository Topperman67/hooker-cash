// Address lookup table contents for Quant Pad launch transactions. The DBC create, the creator
// hand-off to the well, sync and the dev buy reference about 30 accounts (well over Solana's
// 1 232-byte limit at 32 bytes each); with the static ones in a lookup table each costs one byte.
// Static = identical across launches: Meteora's DBC accounts, the launch configs, token programs
// and sysvars, and Quantum Hooks' config. A program a transaction invokes still takes a static
// key, so its table entry only helps where it is passed as a plain account (DBC's event CPI).
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  DBC_EVENT_AUTHORITY,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
} from './meteora.mjs'

/** `launchConfigs`: Quant Pad's DBC configs; `extra`: more keys (Quantum Hooks, the treasury). */
export function staticLaunchAccounts({ launchConfigs = [], extra = [] } = {}) {
  const keys = new Set(
    [
      DBC_PROGRAM_ID,
      DBC_POOL_AUTHORITY,
      DBC_EVENT_AUTHORITY,
      METAPLEX_PROGRAM_ID,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
      SYSVAR_INSTRUCTIONS_PUBKEY,
      SYSVAR_RENT_PUBKEY,
      new PublicKey('ComputeBudget111111111111111111111111111111'),
      ...launchConfigs,
      ...extra,
    ].map((k) => new PublicKey(k).toBase58()),
  )
  return [...keys].map((k) => new PublicKey(k))
}
