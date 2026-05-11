import type {
  AptosIntegration,
  AptosPlugins,
} from '../../../types/aptosIntegration'
import type {
  ConcentratedRangeLiquidityDefiPosition,
  ConstantProductLiquidityDefiPosition,
} from '../../../types/liquidity'
import type { UserDefiPosition } from '../../../types/position'
import type { PositionValue } from '../../../types/positionCommon'

const MERIDIAN_POOL_LENS =
  '0xf501748b0da7a1bde3e040566f1ea0eea1540a28264078a9ee596c0a5fa7bd94' as const
const MERIDIAN_CL_POOL =
  '0x88def51006db6ae8f90051a1531d1b43877eeb233f4c0d99dcb24f49cd27ad5b' as const
const MERIDIAN_CL_FARMING =
  '0x4c5da52eaa510af14e93e7b16dddf3c5d6a9b3f847d18dc8e7499fc71a5a0a24' as const

const MERIDIAN_CL_COLLECTION_DESCRIPTION = 'MeridianCL position collection'
const CLMM_PAGE_SIZE = 50

export const testAddress =
  '0xdd284fb30311654251f1bc7ee9293962e1f28177534a56185ad5a553a72ed911'

interface ObjectRef {
  inner: string
}

interface SignedBits {
  bits: string
}

interface MeridianPoolInfo {
  pool: ObjectRef
  pool_type: number
  lp_token_metadata: ObjectRef
  lp_token_supply: string
  assets_metadata: ObjectRef[]
  balances: string[]
  swap_fee_bps: string
}

interface MeridianClOwnership {
  tokenObjectAddress: string
  poolAddress: string
  positionInfo?: MeridianClPositionInfo
  isStaked?: boolean
}

interface MeridianClPositionInfo {
  liquidity: string
  pool_obj: ObjectRef
  tick_lower: SignedBits
  tick_upper: SignedBits
}

interface MeridianClPoolResource {
  metadata_0: ObjectRef
  metadata_1: ObjectRef
  sqrt_price: string
  swap_fee_bps: string
  tick: SignedBits
}

interface MeridianClIndexerResponse {
  data?: {
    current_token_ownerships_v2?: Array<{
      storage_id: string
      current_token_data?: {
        token_name: string
        current_collection?: {
          creator_address: string
          description: string
        } | null
      } | null
    }>
  }
}

function normalizeAddress(address: string): string {
  if (!address.startsWith('0x')) return address.toLowerCase()
  return `0x${address.slice(2).padStart(64, '0').toLowerCase()}`
}

function normalizeHexPrefix(address: string): string {
  if (!address.startsWith('0x')) return address.toLowerCase()
  return `0x${address.slice(2).toLowerCase()}`
}

function decodeSignedTick(value: SignedBits | string | number): number {
  if (typeof value === 'number') return value

  const bits = BigInt(typeof value === 'string' ? value : value.bits)
  const signBit = 1n << 63n
  const modulus = 1n << 64n
  return Number(bits >= signBit ? bits - modulus : bits)
}

function tickToAdjustedPrice(tick: number, dec0: number, dec1: number): number {
  return 1.0001 ** tick * 10 ** (dec0 - dec1)
}

function sqrtPriceToAdjustedPrice(
  sqrtPrice: string,
  dec0: number,
  dec1: number,
): number {
  const sqrtRatio = Number(BigInt(sqrtPrice)) / 2 ** 64
  return sqrtRatio ** 2 * 10 ** (dec0 - dec1)
}

function getIndexerUrl(plugins: AptosPlugins): string | undefined {
  return (
    plugins.client.config.indexerConfig as
      | {
          indexerUrl?: string
        }
      | undefined
  )?.indexerUrl
}

function getTokenPrice(
  tokenId: string,
  priceByToken: Map<string, number | undefined>,
): number | undefined {
  return priceByToken.get(tokenId)
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

function prorateRawAmount(
  totalAmount: string,
  userLpAmount: string,
  totalLpSupply: string,
): string {
  if (totalLpSupply === '0' || userLpAmount === '0' || totalAmount === '0') {
    return '0'
  }

  return (
    (BigInt(totalAmount) * BigInt(userLpAmount)) /
    BigInt(totalLpSupply)
  ).toString()
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
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
async function findPoolsByLpMetadata(
  plugins: AptosPlugins,
  lpMetadataAddresses: readonly string[],
): Promise<Map<string, MeridianPoolInfo>> {
  if (lpMetadataAddresses.length === 0) return new Map()

  const [poolCountResult] = await view<string>(
    plugins,
    `${MERIDIAN_POOL_LENS}::lens::get_pool_count`,
    [],
  )

  const poolCount = Number(poolCountResult)
  const targetSet = new Set(lpMetadataAddresses.map(normalizeAddress))
  const matchedPools = new Map<string, MeridianPoolInfo>()

  for (let start = 0; start < poolCount; start += CLMM_PAGE_SIZE) {
    const pageResult = await view<MeridianPoolInfo[]>(
      plugins,
      `${MERIDIAN_POOL_LENS}::lens::get_pools_paginated`,
      [start.toString(), CLMM_PAGE_SIZE.toString()],
    )

    const page = pageResult[0] ?? []
    for (const pool of page) {
      const normalizedLpMetadata = normalizeAddress(
        pool.lp_token_metadata.inner,
      )
      if (!targetSet.has(normalizedLpMetadata)) continue

      matchedPools.set(normalizedLpMetadata, pool)
    }

    if (matchedPools.size === targetSet.size) break
  }

  return matchedPools
}

async function getPoolLpPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<ConstantProductLiquidityDefiPosition[]> {
  const lptResult = await view<ObjectRef[]>(
    plugins,
    `${MERIDIAN_POOL_LENS}::lens::account_lpts`,
    [address],
  )
  const userLpMetadata = lptResult[0] ?? []
  if (!userLpMetadata.length) return []

  const lpMetadataAddresses = uniqueStrings(
    userLpMetadata.map((metadata) => normalizeAddress(metadata.inner)),
  )

  const balanceResult = await view<{
    data: Array<{
      key: ObjectRef
      value: string
    }>
  }>(plugins, `${MERIDIAN_POOL_LENS}::lens::user_asset_balances`, [
    address,
    userLpMetadata.map((metadata) => normalizeHexPrefix(metadata.inner)),
  ])

  const userBalanceMap = new Map<string, string>()
  for (const entry of balanceResult[0]?.data ?? []) {
    if (entry.value === '0') continue
    userBalanceMap.set(normalizeAddress(entry.key.inner), entry.value)
  }

  if (!userBalanceMap.size) return []

  const poolsByLpMetadata = await findPoolsByLpMetadata(
    plugins,
    lpMetadataAddresses,
  )
  if (!poolsByLpMetadata.size) return []

  const tokenIds = uniqueStrings([
    ...lpMetadataAddresses,
    ...[...poolsByLpMetadata.values()].flatMap((pool) =>
      pool.assets_metadata.map((asset) => asset.inner),
    ),
  ])
  const tokenMetadata = await plugins.tokens.fetchMany(tokenIds)
  const priceByToken = new Map<string, number | undefined>(
    [...tokenMetadata.entries()].map(([tokenId, token]) => [
      tokenId,
      token?.priceUsd,
    ]),
  )

  const result: ConstantProductLiquidityDefiPosition[] = []

  for (const [lpMetadataAddress, userLpAmount] of userBalanceMap.entries()) {
    const pool = poolsByLpMetadata.get(lpMetadataAddress)
    if (!pool) continue

    const poolTokens = pool.assets_metadata.map((asset, index) => {
      const tokenId = asset.inner
      const tokenInfo = tokenMetadata.get(tokenId)
      const decimals = tokenInfo?.decimals ?? 8
      const priceUsd = getTokenPrice(tokenId, priceByToken)
      const rawAmount = prorateRawAmount(
        pool.balances[index] ?? '0',
        userLpAmount,
        pool.lp_token_supply,
      )

      return buildPositionValue(tokenId, rawAmount, decimals, priceUsd)
    })

    const nonZeroPoolTokens = poolTokens.filter(
      (token) => token.amount.amount !== '0',
    )
    if (!nonZeroPoolTokens.length) continue

    const usdValue = sumUsdValues(nonZeroPoolTokens)
    const position: ConstantProductLiquidityDefiPosition = {
      positionKind: 'liquidity',
      liquidityModel: 'constant-product',
      platformId: 'meridian',
      poolAddress: pool.pool.inner,
      feeBps: pool.swap_fee_bps,
      lpTokenAmount: userLpAmount,
      poolTokens: nonZeroPoolTokens,
      ...(usdValue !== undefined && { usdValue }),
    }

    result.push(position)
  }

  return result
}

async function fetchUserClmmOwnerships(
  address: string,
  indexerUrl: string,
): Promise<MeridianClOwnership[]> {
  const query = `{
    current_token_ownerships_v2(
      where: {
        owner_address: {_eq: "${address}"},
        amount: {_gt: "0"}
      }
    ) {
      storage_id
      current_token_data {
        token_name
        current_collection {
          creator_address
          description
        }
      }
    }
  }`

  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })

  if (!response.ok) return []

  const json = (await response.json()) as MeridianClIndexerResponse
  const ownerships = json.data?.current_token_ownerships_v2 ?? []

  return ownerships.flatMap((ownership) => {
    const tokenData = ownership.current_token_data
    const collection = tokenData?.current_collection
    if (!tokenData || !collection) return []

    const isMeridianPosition =
      collection.description === MERIDIAN_CL_COLLECTION_DESCRIPTION ||
      tokenData.token_name.startsWith('MeridianCLToken:')
    if (!isMeridianPosition) return []

    return [
      {
        tokenObjectAddress: normalizeAddress(ownership.storage_id),
        poolAddress: normalizeAddress(collection.creator_address),
      },
    ]
  })
}

async function fetchUserStakedClmmPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<MeridianClOwnership[]> {
  const result = await view<ObjectRef[] | MeridianClPositionInfo[]>(
    plugins,
    `${MERIDIAN_CL_FARMING}::farming::user_deposits_and_position_info`,
    [address],
  )

  const tokenObjects = (result[0] as ObjectRef[] | undefined) ?? []
  const positionInfos =
    (result[1] as MeridianClPositionInfo[] | undefined) ?? []

  return tokenObjects.flatMap((tokenObject, index) => {
    const positionInfo = positionInfos[index]
    if (!positionInfo) return []

    return [
      {
        tokenObjectAddress: normalizeAddress(tokenObject.inner),
        poolAddress: normalizeAddress(positionInfo.pool_obj.inner),
        positionInfo,
        isStaked: true,
      },
    ]
  })
}

async function getStakedClmmRewardMap(
  tokenObjectAddresses: readonly string[],
  plugins: AptosPlugins,
): Promise<Map<string, PositionValue[]>> {
  if (!tokenObjectAddresses.length) return new Map()

  const rewardEntries = new Map<
    string,
    Array<{ tokenId: string; amount: string }>
  >()

  for (const tokenObjectAddress of tokenObjectAddresses) {
    const incentivesResult = await view<ObjectRef>(
      plugins,
      `${MERIDIAN_CL_FARMING}::farming::active_incentives_by_token`,
      [normalizeHexPrefix(tokenObjectAddress)],
    )

    const incentives = incentivesResult[0] ?? []
    for (const incentive of incentives as ObjectRef[]) {
      const incentiveInfoResult = await view<ObjectRef | string>(
        plugins,
        `${MERIDIAN_CL_FARMING}::farming::incentive_info`,
        [normalizeHexPrefix(incentive.inner)],
      )

      const rewardToken = incentiveInfoResult[0] as ObjectRef
      const claimableRewardResult = await view<string>(
        plugins,
        `${MERIDIAN_CL_FARMING}::farming::claimable_reward_amount`,
        [
          normalizeHexPrefix(tokenObjectAddress),
          normalizeHexPrefix(rewardToken.inner),
        ],
      )

      const rewardAmount = String(claimableRewardResult[0] ?? '0')
      if (rewardAmount === '0') continue

      const currentRewards = rewardEntries.get(tokenObjectAddress) ?? []
      currentRewards.push({
        tokenId: rewardToken.inner,
        amount: rewardAmount,
      })
      rewardEntries.set(tokenObjectAddress, currentRewards)
    }
  }

  if (!rewardEntries.size) return new Map()

  const tokenMetadata = await plugins.tokens.fetchMany(
    uniqueStrings(
      [...rewardEntries.values()].flatMap((rewards) =>
        rewards.map((reward) => reward.tokenId),
      ),
    ),
  )

  return new Map(
    [...rewardEntries.entries()].map(([tokenObjectAddress, rewards]) => [
      tokenObjectAddress,
      rewards.map((reward) => {
        const tokenInfo = tokenMetadata.get(reward.tokenId)
        const decimals = tokenInfo?.decimals ?? 8
        return buildPositionValue(
          reward.tokenId,
          reward.amount,
          decimals,
          tokenInfo?.priceUsd,
        )
      }),
    ]),
  )
}

async function getClmmPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<ConcentratedRangeLiquidityDefiPosition[]> {
  const indexerUrl = getIndexerUrl(plugins)
  if (!indexerUrl) return []

  const [directOwnerships, stakedOwnerships] = await Promise.all([
    fetchUserClmmOwnerships(address, indexerUrl),
    fetchUserStakedClmmPositions(address, plugins),
  ])

  const ownershipMap = new Map<string, MeridianClOwnership>()
  for (const ownership of [...directOwnerships, ...stakedOwnerships]) {
    const existing = ownershipMap.get(ownership.tokenObjectAddress)
    const mergedOwnership: MeridianClOwnership = {
      tokenObjectAddress: ownership.tokenObjectAddress,
      poolAddress: ownership.poolAddress ?? existing?.poolAddress ?? '',
    }

    const positionInfo = ownership.positionInfo ?? existing?.positionInfo
    if (positionInfo !== undefined) mergedOwnership.positionInfo = positionInfo

    const isStaked = ownership.isStaked ?? existing?.isStaked
    if (isStaked !== undefined) mergedOwnership.isStaked = isStaked

    ownershipMap.set(ownership.tokenObjectAddress, mergedOwnership)
  }

  const ownerships = [...ownershipMap.values()]
  if (!ownerships.length) return []

  const stakedRewardMap = await getStakedClmmRewardMap(
    ownerships
      .filter((ownership) => ownership.isStaked)
      .map((ownership) => ownership.tokenObjectAddress),
    plugins,
  )

  const positionDetails = await Promise.allSettled(
    ownerships.map(async (ownership) => {
      const [
        positionInfoResult,
        positionValueResult,
        feesResult,
        poolResource,
      ] = await Promise.all([
        ownership.positionInfo
          ? Promise.resolve([
              ownership.positionInfo,
            ] as MeridianClPositionInfo[])
          : view<MeridianClPositionInfo>(
              plugins,
              `${MERIDIAN_CL_POOL}::pool::position_info`,
              [ownership.tokenObjectAddress],
            ),
        view<string>(
          plugins,
          `${MERIDIAN_CL_POOL}::pool::position_total_value`,
          [ownership.tokenObjectAddress],
        ),
        view<string>(plugins, `${MERIDIAN_CL_POOL}::pool::fees_available`, [
          ownership.tokenObjectAddress,
        ]),
        plugins.client.getAccountResource<MeridianClPoolResource>({
          accountAddress: ownership.poolAddress as `0x${string}`,
          resourceType: `${MERIDIAN_CL_POOL}::pool::Pool`,
        }),
      ])

      return {
        ownership,
        positionInfo: positionInfoResult[0],
        positionAmounts: positionValueResult as [string, string],
        feeAmounts: feesResult as [string, string],
        poolResource,
      }
    }),
  )

  const successfulDetails = positionDetails.flatMap((detail) =>
    detail.status === 'fulfilled' ? [detail.value] : [],
  )
  if (!successfulDetails.length) return []

  const tokenIds = uniqueStrings(
    successfulDetails.flatMap(({ poolResource }) => [
      poolResource.metadata_0.inner,
      poolResource.metadata_1.inner,
    ]),
  )
  const tokenMetadata = await plugins.tokens.fetchMany(tokenIds)
  const priceByToken = new Map<string, number | undefined>(
    [...tokenMetadata.entries()].map(([tokenId, token]) => [
      tokenId,
      token?.priceUsd,
    ]),
  )

  const result: ConcentratedRangeLiquidityDefiPosition[] = []

  for (const detail of successfulDetails) {
    const { positionInfo, positionAmounts, feeAmounts, poolResource } = detail
    if (!positionInfo) continue

    const token0 = poolResource.metadata_0.inner
    const token1 = poolResource.metadata_1.inner
    const decimals0 = tokenMetadata.get(token0)?.decimals ?? 8
    const decimals1 = tokenMetadata.get(token1)?.decimals ?? 8
    const token0PriceUsd = getTokenPrice(token0, priceByToken)
    const token1PriceUsd = getTokenPrice(token1, priceByToken)

    const liquidity = BigInt(positionInfo.liquidity)
    const principalIsZero =
      positionAmounts[0] === '0' && positionAmounts[1] === '0'
    const feesAreZero = feeAmounts[0] === '0' && feeAmounts[1] === '0'

    if (liquidity === 0n && principalIsZero && feesAreZero) continue

    const currentTick = decodeSignedTick(poolResource.tick)
    const lowerTick = decodeSignedTick(positionInfo.tick_lower)
    const upperTick = decodeSignedTick(positionInfo.tick_upper)

    const poolTokens = [
      buildPositionValue(token0, positionAmounts[0], decimals0, token0PriceUsd),
      buildPositionValue(token1, positionAmounts[1], decimals1, token1PriceUsd),
    ]

    const rewards = [
      feeAmounts[0] !== '0'
        ? buildPositionValue(token0, feeAmounts[0], decimals0, token0PriceUsd)
        : undefined,
      feeAmounts[1] !== '0'
        ? buildPositionValue(token1, feeAmounts[1], decimals1, token1PriceUsd)
        : undefined,
      ...(stakedRewardMap.get(detail.ownership.tokenObjectAddress) ?? []),
    ].filter((reward): reward is PositionValue => reward !== undefined)

    const usdValue = sumUsdValues(poolTokens)
    result.push({
      positionKind: 'liquidity',
      liquidityModel: 'concentrated-range',
      platformId: 'meridian',
      poolAddress: normalizeHexPrefix(positionInfo.pool_obj.inner),
      poolTokens,
      isActive:
        liquidity > 0n && lowerTick <= currentTick && currentTick < upperTick,
      lowerPriceUsd: tickToAdjustedPrice(
        lowerTick,
        decimals0,
        decimals1,
      ).toString(),
      upperPriceUsd: tickToAdjustedPrice(
        upperTick,
        decimals0,
        decimals1,
      ).toString(),
      currentPriceUsd: sqrtPriceToAdjustedPrice(
        poolResource.sqrt_price,
        decimals0,
        decimals1,
      ).toString(),
      feeBps: poolResource.swap_fee_bps,
      ...(usdValue !== undefined && { usdValue }),
      ...(rewards.length > 0 && { rewards }),
    })
  }

  return result
}

async function getUserPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<UserDefiPosition[]> {
  const [lpPositions, clmmPositions] = await Promise.all([
    getPoolLpPositions(address, plugins),
    getClmmPositions(address, plugins),
  ])

  return [...lpPositions, ...clmmPositions]
}

export const meridianIntegration: AptosIntegration = {
  platformId: 'meridian',
  getUserPositions,
}

export default meridianIntegration
