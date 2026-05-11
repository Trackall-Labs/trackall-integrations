import type {
  BaseDefiPosition,
  PositionKind,
  PositionValue,
} from './positionCommon'

export interface LendingSuppliedAsset extends PositionValue {
  /** Collateral factor for this supplied token, decimal string. */
  collateralFactor?: string
  /** Supply rate as a percentage string, e.g. "22.5" for 22.5%. */
  supplyRate?: string
}

export interface LendingBorrowedAsset extends PositionValue {
  /** Borrow interest rate as a percentage string, e.g. "40" for 40%. */
  borrowRate?: string
  /** Maintenance ratio / collateral requirement for this borrowed token (decimal string). */
  maintenanceRatio?: string
}

export interface LendingDefiPosition extends BaseDefiPosition {
  /** Position discriminator for switch-based narrowing. */
  positionKind: Extract<PositionKind, 'lending'>
  /** Deposited/locked assets in lending protocol, if present. */
  supplied?: LendingSuppliedAsset[]
  /** Borrowed debt assets, if present. */
  borrowed?: LendingBorrowedAsset[]
  /** Optional annual interest rate as a percentage string, e.g. "22.5" for 22.5%. */
  apy?: string
  /** Optional health factor (decimal string). */
  healthFactor?: string
}
