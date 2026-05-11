import type {
  BaseDefiPosition,
  PositionKind,
  PositionValue,
} from './positionCommon'

export type LiquidityModel = 'constant-product' | 'concentrated-range'

export interface BaseLiquidityDefiPosition extends BaseDefiPosition {
  /** Position discriminator for switch-based narrowing. */
  positionKind: Extract<PositionKind, 'liquidity'>
  /** Liquidity model used by the protocol: classic AMM or concentrated range model. */
  liquidityModel: LiquidityModel
  /** Optional list of token-level values tied to the liquidity pool. */
  poolTokens: PositionValue[]
  /** Optional accrued swap fees claimable from the liquidity position. */
  fees?: PositionValue[]
  /** Optional liquidity pool contract address. */
  poolAddress?: string
  /** Optional APY value for liquidity rewards, decimal string. */
  liquidityApy?: string
  /** Optional fee tier for the liquidity position. */
  feeBps?: string
}

export interface ConstantProductLiquidityDefiPosition
  extends BaseLiquidityDefiPosition {
  /** Liquidity model marker for this subtype. */
  liquidityModel: Extract<LiquidityModel, 'constant-product'>
  /** Optional total LP token amount for this position (decimal string). */
  lpTokenAmount?: string
}

export interface ConcentratedRangeLiquidityDefiPosition
  extends BaseLiquidityDefiPosition {
  /** Liquidity model marker for this subtype. */
  liquidityModel: Extract<LiquidityModel, 'concentrated-range'>
  /** Explicit activity status for this liquidity position. */
  isActive: boolean
  /** Lower price bound of the position range. */
  lowerPriceUsd: string
  /** Upper price bound of the position range. */
  upperPriceUsd: string
  /** Current pool price for the current state. */
  currentPriceUsd: string
}

export type LiquidityDefiPosition =
  | ConstantProductLiquidityDefiPosition
  | ConcentratedRangeLiquidityDefiPosition
