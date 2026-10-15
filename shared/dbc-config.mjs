// Quant Pad's Meteora DBC launch config: one definition for the tests (local validator), the
// devnet rehearsal and mainnet (scripts/create-dbc-config.mjs). A DBC config cannot be changed
// once created, so these values are proposals until the owner signs them off before mainnet.
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

export const LAUNCH_CONFIG = Object.freeze({
  // The coin: an SPL Token mint with 6 decimals and a fixed 1 B supply, metadata immutable.
  totalTokenSupply: 1_000_000_000,
  // Share of the supply that goes into the DAMM v2 pool at migration (the rest is sold on the curve).
  percentageSupplyOnMigration: 20,
  // SOL in the curve when it migrates to DAMM v2.
  migrationQuoteThresholdSol: 85,
  // Trading fee: 1% once the anti-sniper window has passed; it starts at 25% and falls linearly
  // over the first 2 minutes. A dev buy in the launch transaction pays the 1% minimum.
  baseFeeBps: 100,
  antiSniper: { startingFeeBps: 2_500, numberOfPeriod: 12, totalDurationSecs: 120 },
  // Fee on the migrated DAMM v2 pool, collected in SOL only.
  migratedPoolFeeBps: 100,
  // Share of the migration quote taken as a fee at migration (all of it to the creator side).
  migrationFeePercentage: 0,
})

/**
 * DBC `ConfigParameters` for Quant Pad. Every Quantum coin's creator is its well, so the creator
 * side gets all of the trading fee DBC does not keep (`creatorTradingFeePercentage: 100`), all of
 * the migration fee, and the whole migrated LP, permanently locked. Fees are collected in SOL.
 * `overrides` change any LAUNCH_CONFIG value (the tests use a 5 SOL threshold and no anti-sniper
 * window).
 */
export function launchConfigParameters(overrides = {}) {
  const c = { ...LAUNCH_CONFIG, ...overrides }
  const scheduler = c.antiSniper
    ? {
        startingFeeBps: c.antiSniper.startingFeeBps,
        endingFeeBps: c.baseFeeBps,
        numberOfPeriod: c.antiSniper.numberOfPeriod,
        totalDuration: c.antiSniper.totalDurationSecs,
      }
    : { startingFeeBps: c.baseFeeBps, endingFeeBps: c.baseFeeBps, numberOfPeriod: 0, totalDuration: 0 }
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: c.totalTokenSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: scheduler },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 100,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: c.migrationFeePercentage, creatorFeePercentage: 100 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: c.migratedPoolFeeBps,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 0,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: c.percentageSupplyOnMigration,
    migrationQuoteThreshold: c.migrationQuoteThresholdSol,
  })
}
