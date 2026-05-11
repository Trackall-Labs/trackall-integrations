import type {
  BaseDefiPosition,
  PositionKind,
  PositionValue,
} from './positionCommon'

export type TradingPositionStatus =
  | 'open'
  | 'partially-filled'
  | 'filled'
  | 'cancelled'

export type TradingSide = 'buy' | 'sell'

export type TradingExposureSide = 'long' | 'short'
export type TradingMarketType = 'spot' | 'perp'

export type TradingTriggerCondition = 'above' | 'below'

export interface TradingTrigger {
  /** Trigger price that activates the order. */
  price: string
  /** Whether the trigger fires when price moves above or below the threshold. */
  condition: TradingTriggerCondition
}

export interface TradingOrder {
  /** Side of the active order from the user's perspective. */
  side: TradingSide
  /** Asset amount currently offered by the order. */
  selling: PositionValue
  /** Asset amount expected if the order fully fills. */
  buying: PositionValue
  /** Fraction of the order filled, as a decimal string from 0 to 1. */
  filledFraction?: string
  /** Limit price expressed in quote units per base unit. */
  limitPrice?: string
  /** Optional trigger conditions associated with the order. */
  triggers?: TradingTrigger[]
  /** Current status of the trading position, if exposed. */
  status?: TradingPositionStatus
}

export interface TradingMarketPosition {
  /** Optional side of the leveraged/open position. */
  side?: TradingExposureSide
  /** Optional base or contract size of the position. */
  size?: PositionValue
  /** Optional notional USD value for the position. */
  notionalUsd?: string
  /** Optional leverage multiplier as decimal string. */
  leverage?: string
  /** Optional average entry price. */
  entryPrice?: string
  /** Optional current mark/index price. */
  markPrice?: string
  /** Optional liquidation price. */
  liquidationPrice?: string
  /** Optional cumulative funding PnL. */
  fundingPnl?: string
  /** Optional unrealized PnL. */
  unrealizedPnl?: string
  /** Optional realized PnL. */
  realizedPnl?: string
  /** Optional collateral balances tied to the position. */
  collateral?: PositionValue[]
}

export interface TradingAccountMetrics {
  /** Optional account-level leverage multiplier as decimal string. */
  leverage?: string
  /** Optional account-level health factor as decimal string. */
  healthFactor?: string
  /** Optional initial margin ratio as decimal string. */
  initialMarginRatio?: string
  /** Optional maintenance margin ratio as decimal string. */
  maintenanceMarginRatio?: string
}

export interface TradingDefiPosition extends BaseDefiPosition {
  /** Position discriminator for switch-based narrowing. */
  positionKind: Extract<PositionKind, 'trading'>
  /** Whether the trading venue/market is spot or perpetuals. */
  marketType: TradingMarketType
  /** Whether this trading position uses margin. */
  marginEnabled: boolean
  /** Optional account-wide trading metrics shared across this venue/account. */
  account?: TradingAccountMetrics
  /** Idle balances deposited on the venue and available for trading. */
  deposited?: PositionValue[]
  /** Active buy-side orders on the venue. */
  buyOrders?: TradingOrder[]
  /** Active sell-side orders on the venue. */
  sellOrders?: TradingOrder[]
  /** Open margin/perp positions, if the venue exposes them. */
  positions?: TradingMarketPosition[]
}
