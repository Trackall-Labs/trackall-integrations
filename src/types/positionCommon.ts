export interface TokenAmount {
  /** Token identifier; use blockchain address if available or canonical token symbol. */
  token: string
  /** Amount in raw decimal format (string to avoid precision loss). */
  amount: string
  /** Token decimals (e.g., 18 for ETH/ERC20). */
  decimals: string
}

export interface PositionValue {
  /** Token amount represented by this value entry. */
  amount: TokenAmount
  /** Optional USD value for this component, decimal string. */
  usdValue?: string
  /** Optional token price in USD used for this valuation (decimal string). */
  priceUsd?: string
  /** Optional 24h percentage USD change for this component, decimal string. */
  pctUsdValueChange24?: string
}

export type PositionMetadata = Record<string, Record<string, unknown>>

export type PositionKind =
  | 'lending'
  | 'staking'
  | 'liquidity'
  | 'trading'
  | 'vesting'
  | 'reward'

export interface BaseDefiPosition {
  /** Shared platform identifier from Platform.id. */
  platformId: string
  /** Optional top-level USD value of the position as a decimal string. */
  usdValue?: string
  /** Optional top-level 24h percentage USD change, decimal string. */
  pctUsdValueChange24?: string
  /** Optional integration-specific metadata. */
  meta?: PositionMetadata
  /** Reward token amounts for this position. */
  rewards?: PositionValue[]
}
