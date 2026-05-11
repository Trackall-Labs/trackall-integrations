export * from './lending'
export * from './liquidity'
export * from './positionCommon'
export * from './reward'
export * from './staking'
export * from './trading'
export * from './vesting'

import type { LendingDefiPosition } from './lending'
import type { LiquidityDefiPosition } from './liquidity'
import type { RewardDefiPosition } from './reward'
import type { StakingDefiPosition } from './staking'
import type { TradingDefiPosition } from './trading'
import type { VestingDefiPosition } from './vesting'

export type UserDefiPosition =
  | LendingDefiPosition
  | StakingDefiPosition
  | LiquidityDefiPosition
  | TradingDefiPosition
  | RewardDefiPosition
  | VestingDefiPosition
