import type {
  BaseDefiPosition,
  PositionKind,
  PositionValue,
} from './positionCommon'

export interface RewardDefiPosition extends BaseDefiPosition {
  /** Position discriminator for switch-based narrowing. */
  positionKind: Extract<PositionKind, 'reward'>
  /** Rewards currently claimable by the user, such as airdrops or accrued incentives. */
  claimable?: PositionValue[]
  /** Rewards already claimed from the distribution, if exposed by the protocol. */
  claimed?: PositionValue[]
  /** Optional campaign or distributor identifier. */
  sourceId?: string
  /** Optional timestamp after which rewards become claimable. */
  claimableFrom?: string
  /** Optional expiration timestamp for claiming rewards. */
  expiresAt?: string
}
