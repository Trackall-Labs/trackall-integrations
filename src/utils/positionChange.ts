import type { UserDefiPosition } from '../types/position'
import type { PositionValue } from '../types/positionCommon'

export type TokenPriceSource = {
  get: (token: string) => { pctPriceChange24h?: number } | undefined
}

export interface PositionPctUsdValueChangeOptions {
  borrowedWeight?: number
  ignoredKeys?: Set<string> | readonly string[]
}

const DEFAULT_BORROWED_WEIGHT = -1
const DEFAULT_IGNORED_KEYS = new Set(['meta'])

type PositionPctComponent = {
  token: string
  usd: number
  weight: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertNever(value: never): never {
  throw new Error(`Unsupported position kind: ${JSON.stringify(value)}`)
}

function shouldIncludeKey(ignoredKeys: Set<string>, key: string): boolean {
  return !ignoredKeys.has(key)
}

function appendPositionValue(
  components: PositionPctComponent[],
  value: PositionValue | undefined,
  weight: number,
): void {
  if (value?.usdValue === undefined) return
  if (value.amount.token.length === 0) return

  const usd = Number(value.usdValue)
  if (!Number.isFinite(usd) || usd <= 0) return

  components.push({
    token: value.amount.token,
    usd,
    weight,
  })
}

function appendPositionValues(
  components: PositionPctComponent[],
  values: PositionValue[] | undefined,
  weight: number,
): void {
  if (values === undefined) return

  for (const value of values) {
    appendPositionValue(components, value, weight)
  }
}

function collectPositionPctComponents(
  position: UserDefiPosition,
  borrowedWeight: number,
  ignoredKeys: Set<string>,
): PositionPctComponent[] {
  const components: PositionPctComponent[] = []
  const push = (key: string, values: PositionValue[] | undefined): void => {
    if (!shouldIncludeKey(ignoredKeys, key)) return
    appendPositionValues(components, values, 1)
  }
  const pushOne = (key: string, value: PositionValue | undefined): void => {
    if (!shouldIncludeKey(ignoredKeys, key)) return
    appendPositionValue(components, value, 1)
  }
  const pushBorrowed = (key: string, values: PositionValue[] | undefined) => {
    if (!shouldIncludeKey(ignoredKeys, key)) return
    appendPositionValues(components, values, borrowedWeight)
  }

  push('rewards', position.rewards)

  switch (position.positionKind) {
    case 'lending':
      push('supplied', position.supplied)
      pushBorrowed('borrowed', position.borrowed)
      break

    case 'staking':
      push('staked', position.staked)
      push('unbonding', position.unbonding)
      if (shouldIncludeKey(ignoredKeys, 'staked.claimableReward')) {
        for (const stakedAsset of position.staked ?? []) {
          pushOne('staked.claimableReward', stakedAsset.claimableReward)
        }
      }
      break

    case 'liquidity':
      push('poolTokens', position.poolTokens)
      push('fees', position.fees)
      break

    case 'trading':
      push('deposited', position.deposited)

      if (shouldIncludeKey(ignoredKeys, 'buyOrders.selling')) {
        for (const order of position.buyOrders ?? []) {
          pushOne('buyOrders.selling', order.selling)
        }
      }
      if (shouldIncludeKey(ignoredKeys, 'buyOrders.buying')) {
        for (const order of position.buyOrders ?? []) {
          pushOne('buyOrders.buying', order.buying)
        }
      }
      if (shouldIncludeKey(ignoredKeys, 'sellOrders.selling')) {
        for (const order of position.sellOrders ?? []) {
          pushOne('sellOrders.selling', order.selling)
        }
      }
      if (shouldIncludeKey(ignoredKeys, 'sellOrders.buying')) {
        for (const order of position.sellOrders ?? []) {
          pushOne('sellOrders.buying', order.buying)
        }
      }

      if (shouldIncludeKey(ignoredKeys, 'positions.size')) {
        for (const marketPosition of position.positions ?? []) {
          pushOne('positions.size', marketPosition.size)
        }
      }
      if (shouldIncludeKey(ignoredKeys, 'positions.collateral')) {
        for (const marketPosition of position.positions ?? []) {
          push('positions.collateral', marketPosition.collateral)
        }
      }
      break

    case 'reward':
      push('claimable', position.claimable)
      push('claimed', position.claimed)
      break

    case 'vesting':
      if (shouldIncludeKey(ignoredKeys, 'vesting')) {
        for (const vestingAsset of position.vesting ?? []) {
          pushOne('vesting', vestingAsset)
        }
      }
      if (shouldIncludeKey(ignoredKeys, 'vesting.claimable')) {
        for (const vestingAsset of position.vesting ?? []) {
          pushOne('vesting.claimable', vestingAsset.claimable)
        }
      }
      if (shouldIncludeKey(ignoredKeys, 'vesting.claimed')) {
        for (const vestingAsset of position.vesting ?? []) {
          pushOne('vesting.claimed', vestingAsset.claimed)
        }
      }

      push('claimable', position.claimable)
      push('claimed', position.claimed)
      break

    default:
      assertNever(position)
  }

  return components
}

export function computePositionPctUsdValueChange24(
  tokenSource: TokenPriceSource,
  position: UserDefiPosition,
  options: PositionPctUsdValueChangeOptions = {},
): string | undefined {
  const borrowedWeight = options.borrowedWeight ?? DEFAULT_BORROWED_WEIGHT
  const ignoredKeys = new Set(options.ignoredKeys ?? DEFAULT_IGNORED_KEYS)
  const components = collectPositionPctComponents(
    position,
    borrowedWeight,
    ignoredKeys,
  )

  let weightedPct = 0
  let weightedUsd = 0

  for (const component of components) {
    const pctPriceChange24h = tokenSource.get(
      component.token,
    )?.pctPriceChange24h
    if (!isFiniteNumber(pctPriceChange24h)) continue

    weightedUsd += component.weight * component.usd
    weightedPct += component.weight * component.usd * pctPriceChange24h
  }

  if (!Number.isFinite(weightedUsd) || weightedUsd === 0) return undefined

  const pct = weightedPct / weightedUsd
  return Number.isFinite(pct) ? pct.toString() : undefined
}

export function applyPositionPctUsdValueChange24(
  tokenSource: TokenPriceSource,
  position: UserDefiPosition,
  options: PositionPctUsdValueChangeOptions = {},
): void {
  const pctUsdValueChange24 = computePositionPctUsdValueChange24(
    tokenSource,
    position,
    options,
  )

  if (pctUsdValueChange24 !== undefined) {
    position.pctUsdValueChange24 = pctUsdValueChange24
  }
}

export function applyPositionsPctUsdValueChange24(
  tokenSource: TokenPriceSource,
  positions: UserDefiPosition[],
  options: PositionPctUsdValueChangeOptions = {},
): void {
  for (const position of positions) {
    applyPositionPctUsdValueChange24(tokenSource, position, options)
  }
}
