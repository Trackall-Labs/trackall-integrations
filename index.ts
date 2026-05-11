import { readdir } from 'node:fs/promises'
import type { AptosIntegration } from './src/types/aptosIntegration'
import type { SolanaIntegration } from './src/types/solanaIntegration'

const solanaDir = new URL('./src/integrations/solana/', import.meta.url)
const movementDir = new URL('./src/integrations/movement/', import.meta.url)

async function loadIntegrations(dir: URL) {
  const entries = await readdir(dir, { withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        name: entry.name,
        module: (await import(
          new URL(`${entry.name}/index.ts`, dir).href
        )) as Record<string, unknown>,
      })),
  )
}

function getProgramIdsFromModule(
  moduleName: string,
  module: Record<string, unknown>,
): readonly string[] {
  const value = module.PROGRAM_IDS
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Solana integration "${moduleName}" must export a non-empty PROGRAM_IDS array`,
    )
  }

  if (!value.every((item): item is string => typeof item === 'string')) {
    throw new Error(
      `Solana integration "${moduleName}" has an invalid PROGRAM_IDS export; all items must be strings`,
    )
  }

  return value
}

const [solanaModules, movementModules] = await Promise.all([
  loadIntegrations(solanaDir),
  loadIntegrations(movementDir),
])

export const solanaIntegrations: SolanaIntegration[] = solanaModules.map(
  (entry) => entry.module.default as SolanaIntegration,
)
export const movementIntegrations: AptosIntegration[] = movementModules.map(
  (entry) => entry.module.default as AptosIntegration,
)
export const solanaIndexedPrograms = [
  ...new Set(
    solanaModules.flatMap((entry) =>
      getProgramIdsFromModule(entry.name, entry.module),
    ),
  ),
]
export const solanaIndexedProgramsByPlatformId = Object.fromEntries(
  solanaModules.map((entry) => {
    const integration = entry.module.default as SolanaIntegration

    return [
      integration.platformId,
      [...new Set(getProgramIdsFromModule(entry.name, entry.module))],
    ]
  }),
)

export type { PlatformId } from './src/platforms/index'
export { platforms } from './src/platforms/index'
export type {
  AptosTokenData,
  AptosTokenIdentifier,
  AptosTokenStandard,
} from './src/plugin/aptos/tokens'
// Utilities
export { AptosTokenPlugin } from './src/plugin/aptos/tokens'
export type {
  TokenCreator,
  TokenData,
  TokensMap,
} from './src/plugin/solana/tokens'
export { TokenPlugin } from './src/plugin/solana/tokens'
// Types
export type {
  AptosAccountsMap,
  AptosAddress,
  AptosIntegration,
  AptosPlugins,
  AptosResource,
} from './src/types/aptosIntegration'
export type {
  Platform,
  PlatformLinks,
  PlatformLocation,
} from './src/types/platform'
export type { PlatformTag } from './src/types/platformTag'
export type {
  BaseDefiPosition,
  BaseLiquidityDefiPosition,
  ConcentratedRangeLiquidityDefiPosition,
  ConstantProductLiquidityDefiPosition,
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  LiquidityDefiPosition,
  LiquidityModel,
  PositionKind,
  PositionValue,
  RewardDefiPosition,
  StakedAsset,
  StakingDefiPosition,
  TokenAmount,
  TradingAccountMetrics,
  TradingDefiPosition,
  TradingExposureSide,
  TradingMarketPosition,
  TradingMarketType,
  TradingOrder,
  TradingPositionStatus,
  TradingSide,
  TradingTrigger,
  TradingTriggerCondition,
  UserDefiPosition,
  VestingAsset,
  VestingDefiPosition,
} from './src/types/position'
export { runIntegrations } from './src/types/runner'
export type {
  AccountsMap,
  MaybeSolanaAccount,
  ProgramAccountFilter,
  ProgramRequest,
  SolanaAccount,
  SolanaAccountNotFound,
  SolanaAddress,
  SolanaIntegration,
  SolanaPlugins,
  UserPositionsPlan,
  UsersFilter,
  UsersFilterPlan,
  UsersFilterSource,
} from './src/types/solanaIntegration'
export {
  createFetchAccounts,
  createFetchProgramAccounts,
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from './src/utils/solana'
