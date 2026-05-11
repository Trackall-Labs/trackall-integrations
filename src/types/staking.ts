import type {
  BaseDefiPosition,
  PositionKind,
  PositionValue,
} from './positionCommon'

export interface StakedAsset extends PositionValue {
  /** Optional claimable rewards tied directly to this staked token. */
  claimableReward?: PositionValue
  /** Optional annual reward rate (APR/APY decimal string). */
  rewardRate?: string
  /** Optional cooldown period for unstaking in seconds (decimal string). */
  cooldownPeriod?: string
}

export interface StakingDefiPosition extends BaseDefiPosition {
  /** Position discriminator for switch-based narrowing. */
  positionKind: Extract<PositionKind, 'staking'>
  /** Staked assets in the protocol. */
  staked?: StakedAsset[]
  /** Optional APY value for staking rewards, decimal string. */
  apy?: string
  /** Assets currently in unbonding/unlocking period, if present. */
  unbonding?: PositionValue[]
  /** Optional lock-up end timestamp for the position. */
  lockedUntil?: string
  /** Optional lock duration in seconds (decimal string). */
  lockDuration?: string
  /** Optional total staked amount, if position is represented as a single aggregate value. */
  totalStakedUsd?: string
}
