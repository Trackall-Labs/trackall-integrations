import type {
  AptosIntegration,
  AptosPlugins,
} from '../../../types/aptosIntegration'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
} from '../../../types/lending'
import type { UserDefiPosition } from '../../../types/position'
import type { PositionValue } from '../../../types/positionCommon'

const ECHELON_CONTRACT =
  '0x6a01d5761d43a5b5a0ccbfc42edf2d02c0611464aae99a2ea0e0d4819f0550b5' as const

export const testAddress =
  '0xdd284fb30311654251f1bc7ee9293962e1f28177534a56185ad5a553a72ed911'

interface ObjectRef {
  inner: string
}

interface FixedPoint64 {
  v: string
}

function fixedPoint64ToNumber(value: FixedPoint64 | string): number {
  const raw = typeof value === 'string' ? value : value.v
  return Number(raw) / 2 ** 64
}

function buildPositionValue(
  token: string,
  rawAmount: string,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const amount = Number(rawAmount) / 10 ** decimals
  const usdValue =
    priceUsd !== undefined ? (amount * priceUsd).toString() : undefined

  return {
    amount: {
      token,
      amount: rawAmount,
      decimals: decimals.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function sumUsdValues(values: PositionValue[]): string | undefined {
  const numericValues = values
    .map((value) =>
      value.usdValue === undefined ? undefined : Number(value.usdValue),
    )
    .filter((value): value is number => value !== undefined)

  if (!numericValues.length) return undefined
  return numericValues.reduce((sum, value) => sum + value, 0).toString()
}

async function view<T>(
  plugins: AptosPlugins,
  functionName: string,
  functionArguments: unknown[],
): Promise<T[]> {
  return (await plugins.client.view({
    payload: {
      function: functionName as `${string}::${string}::${string}`,
      typeArguments: [],
      functionArguments: functionArguments as never[],
    },
  })) as T[]
}

async function getTokenId(
  plugins: AptosPlugins,
  market: string,
): Promise<string> {
  try {
    const result = await view<ObjectRef>(
      plugins,
      `${ECHELON_CONTRACT}::lending::market_asset_metadata`,
      [market],
    )
    return (result[0] as ObjectRef).inner
  } catch {
    const result = await view<string>(
      plugins,
      `${ECHELON_CONTRACT}::lending::market_coin`,
      [market],
    )
    return String(result[0])
  }
}

async function getRewards(
  address: string,
  activeMarkets: string[],
  plugins: AptosPlugins,
): Promise<PositionValue[]> {
  const rewardResults = await Promise.allSettled(
    activeMarkets.map((market) =>
      view<string>(
        plugins,
        `${ECHELON_CONTRACT}::farming::claimable_reward_amount`,
        [address, market],
      ),
    ),
  )

  const rewardItems: Array<{ market: string; amount: string }> = []
  for (let i = 0; i < activeMarkets.length; i++) {
    const result = rewardResults[i]
    if (result?.status !== 'fulfilled') continue
    const amount = String(result.value[0] ?? '0')
    if (amount === '0') continue
    rewardItems.push({ market: activeMarkets[i] as string, amount })
  }

  if (rewardItems.length === 0) return []

  const rewardValues = await Promise.allSettled(
    rewardItems.map(async ({ market, amount }) => {
      const tokenId = await getTokenId(plugins, market)
      const tokenInfo = await plugins.tokens.fetch(tokenId)
      const decimals = tokenInfo?.decimals ?? 8
      const priceUsd = tokenInfo?.priceUsd
      return buildPositionValue(
        tokenId,
        amount,
        decimals,
        priceUsd !== undefined ? Number(priceUsd) : undefined,
      )
    }),
  )

  return rewardValues.flatMap((r) =>
    r.status === 'fulfilled' ? [r.value] : [],
  )
}

async function getUserPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<UserDefiPosition[]> {
  // Early-exit: skip if the user has no supply or borrow positions
  const [lendValueResult, liabilityValueResult] = await Promise.all([
    view<FixedPoint64>(
      plugins,
      `${ECHELON_CONTRACT}::lending::account_lend_value`,
      [address],
    ),
    view<FixedPoint64>(
      plugins,
      `${ECHELON_CONTRACT}::lending::account_liability_value`,
      [address],
    ),
  ])

  const lendValue = fixedPoint64ToNumber(lendValueResult[0] ?? '0')
  const liabilityValue = fixedPoint64ToNumber(liabilityValueResult[0] ?? '0')

  if (lendValue === 0 && liabilityValue === 0) return []

  // Get all markets
  const [marketsResult] = await view<ObjectRef[]>(
    plugins,
    `${ECHELON_CONTRACT}::lending::market_objects`,
    [],
  )
  const markets = (marketsResult ?? []).map((m) => m.inner)

  if (markets.length === 0) return []

  // Check user balances across all markets
  const balanceResults = await Promise.allSettled(
    markets.map(async (market) => {
      const [coinsResult, liabilityResult] = await Promise.all([
        view<string>(plugins, `${ECHELON_CONTRACT}::lending::account_coins`, [
          address,
          market,
        ]),
        view<string>(
          plugins,
          `${ECHELON_CONTRACT}::lending::account_liability`,
          [address, market],
        ),
      ])
      return {
        market,
        coins: String(coinsResult[0] ?? '0'),
        liability: String(liabilityResult[0] ?? '0'),
      }
    }),
  )

  const activeMarkets = balanceResults.flatMap((r) => {
    if (r.status !== 'fulfilled') return []
    const { coins, liability } = r.value
    if (coins === '0' && liability === '0') return []
    return [r.value]
  })

  if (activeMarkets.length === 0) return []

  // Compute health factor once for the whole account
  let accountHealthFactor: string | undefined
  if (liabilityValue > 0) {
    try {
      const liquidationThresholdResult = await view<FixedPoint64>(
        plugins,
        `${ECHELON_CONTRACT}::lending::account_liquidation_threshold`,
        [address],
      )
      const liquidationThreshold = fixedPoint64ToNumber(
        liquidationThresholdResult[0] ?? '0',
      )
      if (liabilityValue > 0) {
        accountHealthFactor = (liquidationThreshold / liabilityValue).toString()
      }
    } catch {
      // health factor is optional
    }
  }

  // Fetch detailed info for each active market in parallel
  const marketDetails = await Promise.allSettled(
    activeMarkets.map(async ({ market, coins, liability }) => {
      const hasSupply = coins !== '0'
      const hasBorrow = liability !== '0'

      const [
        tokenId,
        assetPriceResult,
        supplyRateResult,
        collateralFactorResult,
        liquidationThresholdBpsResult,
      ] = await Promise.all([
        getTokenId(plugins, market),
        view<FixedPoint64>(
          plugins,
          `${ECHELON_CONTRACT}::lending::asset_price`,
          [market],
        ),
        hasSupply
          ? view<FixedPoint64>(
              plugins,
              `${ECHELON_CONTRACT}::lending::supply_interest_rate`,
              [market],
            )
          : Promise.resolve([] as FixedPoint64[]),
        view<string>(
          plugins,
          `${ECHELON_CONTRACT}::lending::market_collateral_factor_bps`,
          [market],
        ),
        view<string>(
          plugins,
          `${ECHELON_CONTRACT}::lending::market_liquidation_threshold_bps`,
          [market],
        ),
      ])

      const borrowRateResult = hasBorrow
        ? await view<FixedPoint64>(
            plugins,
            `${ECHELON_CONTRACT}::lending::borrow_interest_rate`,
            [market],
          )
        : ([] as FixedPoint64[])

      const tokenInfo = await plugins.tokens.fetch(tokenId)
      const decimals = tokenInfo?.decimals ?? 8
      const priceUsd = fixedPoint64ToNumber(assetPriceResult[0] ?? '0')

      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []

      if (hasSupply) {
        supplied.push({
          ...buildPositionValue(tokenId, coins, decimals, priceUsd),
          collateralFactor: (
            Number(collateralFactorResult[0] ?? '0') / 10_000
          ).toString(),
          ...(supplyRateResult.length > 0 &&
            supplyRateResult[0] !== undefined && {
              supplyRate: fixedPoint64ToNumber(supplyRateResult[0]).toString(),
            }),
        })
      }

      if (hasBorrow) {
        borrowed.push({
          ...buildPositionValue(tokenId, liability, decimals, priceUsd),
          maintenanceRatio: (
            Number(liquidationThresholdBpsResult[0] ?? '0') / 10_000
          ).toString(),
          ...(borrowRateResult.length > 0 &&
            borrowRateResult[0] !== undefined && {
              borrowRate: fixedPoint64ToNumber(borrowRateResult[0]).toString(),
            }),
        })
      }

      return { supplied, borrowed }
    }),
  )

  // Aggregate all markets into a single lending position
  const allSupplied: LendingSuppliedAsset[] = []
  const allBorrowed: LendingBorrowedAsset[] = []

  for (const detail of marketDetails) {
    if (detail.status !== 'fulfilled') continue
    allSupplied.push(...detail.value.supplied)
    allBorrowed.push(...detail.value.borrowed)
  }

  if (allSupplied.length === 0 && allBorrowed.length === 0) return []

  // Fetch farming rewards
  const rewards = await getRewards(
    address,
    activeMarkets.map((m) => m.market),
    plugins,
  )

  const suppliedUsd = sumUsdValues(allSupplied)
  const borrowedUsd = sumUsdValues(allBorrowed)
  const netValueUsd =
    suppliedUsd !== undefined && borrowedUsd !== undefined
      ? (Number(suppliedUsd) - Number(borrowedUsd)).toString()
      : suppliedUsd

  const position: LendingDefiPosition = {
    positionKind: 'lending',
    platformId: 'echelon',
    ...(allSupplied.length > 0 && { supplied: allSupplied }),
    ...(allBorrowed.length > 0 && { borrowed: allBorrowed }),
    ...(netValueUsd !== undefined && { usdValue: netValueUsd }),
    ...(accountHealthFactor !== undefined &&
      allBorrowed.length > 0 && { healthFactor: accountHealthFactor }),
    ...(rewards.length > 0 && { rewards }),
  }

  return [position]
}

export const echelonIntegration: AptosIntegration = {
  platformId: 'echelon',
  getUserPositions,
}

export default echelonIntegration
