import type {
  BaseDefiPosition,
  PositionKind,
  PositionValue,
} from './positionCommon'

export interface VestingAsset extends PositionValue {
  /** Optional amount already unlocked and claimable for this vesting asset. */
  claimable?: PositionValue
  /** Optional amount already claimed from this vesting asset. */
  claimed?: PositionValue
}

export interface VestingDefiPosition extends BaseDefiPosition {
  /** Position discriminator for switch-based narrowing. */
  positionKind: Extract<PositionKind, 'vesting'>
  /** Assets governed by the vesting schedule. */
  vesting?: VestingAsset[]
  /** Optional aggregate list of tokens currently claimable. */
  claimable?: PositionValue[]
  /** Optional aggregate list of tokens already claimed. */
  claimed?: PositionValue[]
  /** Optional vesting start timestamp. */
  startTime?: string
  /** Optional cliff timestamp after which tokens start unlocking. */
  cliffTime?: string
  /** Optional vesting completion timestamp. */
  endTime?: string
  /** Optional unlock cadence in seconds. */
  unlockFrequencySeconds?: string
}
