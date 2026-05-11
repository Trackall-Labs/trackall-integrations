import type {
  AptosIntegration,
  AptosPlugins,
} from '../../../types/aptosIntegration'
import type { ConstantProductLiquidityDefiPosition } from '../../../types/liquidity'
import type { UserDefiPosition } from '../../../types/position'
import type { PositionValue } from '../../../types/positionCommon'
import type { StakingDefiPosition } from '../../../types/staking'

const MOSAIC_AMM =
  '0x26a95d4bd7d7fc3debf6469ff94837e03e887088bef3a3f2d08d1131141830d3' as const
const MOSAIC_STAKING =
  '0x9b8e8dbc2ec9d3f473757dd1a95c96e029d7eef01e721788ea71293f736c9e7c' as const
const MOSAIC_STATS_API = 'https://stats.mosaic.ag/v1/public' as const

export const testAddress =
  '0xdd284fb30311654251f1bc7ee9293962e1f28177534a56185ad5a553a72ed911'

interface ObjectRef {
  inner: string
}

interface MosaicPoolView {
  fee: string
  is_locked: boolean
  is_stable: boolean
  pool_addr: string
  protocol_fee: string
  token_x: string
  token_x_reserve: string
  token_y: string
  token_y_reserve: string
  x_scale: string
  y_scale: string
}

interface MosaicPoolStats {
  tvl_usd?: number
  volume_24h_usd?: number
  apr?: number
  apr_fees?: number
  apr_farming_rewards?: number
}

interface MosaicPoolStatsEntry {
  pool_address: string
  stats?: MosaicPoolStats
}

interface MosaicPoolStatsResponse {
  data?: {
    pools?: MosaicPoolStatsEntry[]
  }
}

interface MosaicFarmStatsEntry {
  address: string
  metadata?: {
    stake_token: string
    reward_token: string
    start_timestamp: number
    end_timestamp: number
    reward_per_second: number
  }
  stats?: {
    total_staked_usd?: number
    apr?: number
  }
}

interface MosaicFarmStatsResponse {
  data?: {
    farms?: MosaicFarmStatsEntry[]
  }
}

interface MosaicIndexerMetadata {
  asset_type: string
  creator_address?: string | null
  name?: string | null
  symbol?: string | null
  decimals?: number | null
  icon_uri?: string | null
  supply_v2?: number | string | null
}

interface MosaicFungibleAssetBalance {
  amount: number | string
  asset_type: string
  asset_type_v2?: string | null
  metadata?: MosaicIndexerMetadata | null
}

interface MosaicIndexerBalancesResponse {
  current_fungible_asset_balances?: MosaicFungibleAssetBalance[]
}

interface MosaicIndexerMetadataResponse {
  fungible_asset_metadata?: MosaicIndexerMetadata[]
}

interface MosaicUserStakeInfoView {
  pool_address: string
  amount: string
  pending_rewards: string
  unlock_time: string
  boosted_amount: string
}

interface MosaicFarmPoolStateView {
  stake_token: ObjectRef
  reward_token: ObjectRef
  reward_per_sec: string
  start_timestamp: string
  end_timestamp: string
  last_accum_reward_updated: string
  total_staked: string
  total_boosted: string
}

function normalizeAddress(address: string): string {
  if (!address.startsWith('0x')) return address.toLowerCase()
  return `0x${address.slice(2).padStart(64, '0').toLowerCase()}`
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
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

function rawToString(value: number | string | null | undefined): string {
  if (value === undefined || value === null) return '0'
  return String(value)
}

function buildPositionValue(
  token: string,
  rawAmount: string,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const value: PositionValue = {
    amount: {
      token,
      amount: rawAmount,
      decimals: decimals.toString(),
    },
  }
  if (priceUsd !== undefined) {
    value.priceUsd = priceUsd.toString()
    const usd = (Number(rawAmount) / 10 ** decimals) * priceUsd
    if (Number.isFinite(usd) && usd > 0) {
      value.usdValue = usd.toString()
    }
  }
  return value
}

function prorateRawAmount(
  totalAmount: string,
  userLpAmount: string,
  totalLpSupply: string,
): string {
  if (totalAmount === '0' || userLpAmount === '0' || totalLpSupply === '0') {
    return '0'
  }

  return (
    (BigInt(totalAmount) * BigInt(userLpAmount)) /
    BigInt(totalLpSupply)
  ).toString()
}

function prorateDecimalValue(
  totalValue: number | undefined,
  userAmount: string,
  totalAmount: string,
): string | undefined {
  if (totalValue === undefined || userAmount === '0' || totalAmount === '0') {
    return undefined
  }

  const scale = 1_000_000n
  const scaledTotal = BigInt(Math.round(totalValue * Number(scale)))
  const prorated = (scaledTotal * BigInt(userAmount)) / BigInt(totalAmount)

  return (Number(prorated) / Number(scale)).toString()
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Mosaic request failed: ${response.status} ${url}`)
  }

  return (await response.json()) as T
}

async function queryIndexer<T>(
  indexerUrl: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`Mosaic indexer request failed: ${response.status}`)
  }

  const json = (await response.json()) as {
    data?: T
    errors?: Array<{ message?: string }>
  }

  if (json.data !== undefined) return json.data

  const errorMessage =
    json.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join('; ') || 'unknown indexer error'
  throw new Error(`Mosaic indexer query failed: ${errorMessage}`)
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

async function getMosaicPoolStatsMap(): Promise<
  Map<string, MosaicPoolStatsEntry>
> {
  const response = await fetchJson<MosaicPoolStatsResponse>(
    `${MOSAIC_STATS_API}/pools`,
  )
  const pools = response.data?.pools ?? []

  return new Map(
    pools.map((pool) => [normalizeAddress(pool.pool_address), pool] as const),
  )
}

async function getMosaicFarmStatsMap(): Promise<
  Map<string, MosaicFarmStatsEntry>
> {
  const response = await fetchJson<MosaicFarmStatsResponse>(
    `${MOSAIC_STATS_API}/farms`,
  )
  const farms = response.data?.farms ?? []

  return new Map(
    farms.map((farm) => [normalizeAddress(farm.address), farm] as const),
  )
}

async function getPoolViewMap(
  poolIds: readonly string[],
  plugins: AptosPlugins,
): Promise<Map<string, MosaicPoolView>> {
  const results = await Promise.allSettled(
    poolIds.map(async (poolId) => {
      const viewResult = await view<MosaicPoolView>(
        plugins,
        `${MOSAIC_AMM}::liquidity_pool::get_pool_view`,
        [poolId],
      )

      const poolView = viewResult[0]
      return poolView === undefined
        ? null
        : ([normalizeAddress(poolView.pool_addr), poolView] as const)
    }),
  )

  const map = new Map<string, MosaicPoolView>()
  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value === null) continue
    map.set(result.value[0], result.value[1])
  }

  return map
}

async function getUserLpBalances(
  address: string,
  poolIds: readonly string[],
  plugins: AptosPlugins,
): Promise<Map<string, string>> {
  const indexerUrl = getIndexerUrl(plugins)
  if (!indexerUrl || poolIds.length === 0) return new Map()

  const query = `
    query MosaicWalletLp($owner: String!, $assetTypes: [String!]) {
      current_fungible_asset_balances(
        where: {
          owner_address: { _eq: $owner }
          amount: { _gt: "0" }
          asset_type: { _in: $assetTypes }
        }
      ) {
        amount
        asset_type
        asset_type_v2
      }
    }
  `

  const data = await queryIndexer<MosaicIndexerBalancesResponse>(
    indexerUrl,
    query,
    {
      owner: address,
      assetTypes: poolIds,
    },
  )

  const balanceMap = new Map<string, string>()
  for (const balance of data.current_fungible_asset_balances ?? []) {
    const poolId = normalizeAddress(balance.asset_type_v2 ?? balance.asset_type)
    balanceMap.set(poolId, rawToString(balance.amount))
  }

  return balanceMap
}

async function getLpMetadataMap(
  lpTokenIds: readonly string[],
  plugins: AptosPlugins,
): Promise<Map<string, MosaicIndexerMetadata>> {
  const indexerUrl = getIndexerUrl(plugins)
  if (!indexerUrl || lpTokenIds.length === 0) return new Map()

  const query = `
    query MosaicLpMetadata($assetTypes: [String!]) {
      fungible_asset_metadata(where: { asset_type: { _in: $assetTypes } }) {
        asset_type
        creator_address
        name
        symbol
        decimals
        icon_uri
        supply_v2
      }
    }
  `

  const data = await queryIndexer<MosaicIndexerMetadataResponse>(
    indexerUrl,
    query,
    {
      assetTypes: lpTokenIds,
    },
  )

  return new Map(
    (data.fungible_asset_metadata ?? []).map((metadata) => [
      normalizeAddress(metadata.asset_type),
      metadata,
    ]),
  )
}

async function getUserStakeInfos(
  farmAddresses: readonly string[],
  address: string,
  plugins: AptosPlugins,
): Promise<MosaicUserStakeInfoView[]> {
  if (!farmAddresses.length) return []

  const userStakeResult = await view<MosaicUserStakeInfoView[]>(
    plugins,
    `${MOSAIC_STAKING}::staking_pool::get_user_stake_infos`,
    [farmAddresses, address],
  )

  return (userStakeResult[0] as MosaicUserStakeInfoView[] | undefined) ?? []
}

async function getDirectLiquidityPositions(
  userLpBalances: ReadonlyMap<string, string>,
  poolViewMap: ReadonlyMap<string, MosaicPoolView>,
  lpMetadataMap: ReadonlyMap<string, MosaicIndexerMetadata>,
  poolStatsMap: ReadonlyMap<string, MosaicPoolStatsEntry>,
  plugins: AptosPlugins,
): Promise<ConstantProductLiquidityDefiPosition[]> {
  if (!userLpBalances.size) return []

  const underlyingTokenIds = uniqueStrings(
    [...poolViewMap.values()].flatMap((pool) => [pool.token_x, pool.token_y]),
  )
  const tokenMetadata = await plugins.tokens.fetchMany(underlyingTokenIds)

  const positions: ConstantProductLiquidityDefiPosition[] = []

  for (const [lpTokenId, userLpAmount] of userLpBalances.entries()) {
    const poolView = poolViewMap.get(lpTokenId)
    const lpMetadata = lpMetadataMap.get(lpTokenId)
    if (!poolView || !lpMetadata) continue

    const totalLpSupply = rawToString(lpMetadata.supply_v2)
    if (totalLpSupply === '0') continue

    const tokenXData = tokenMetadata.get(poolView.token_x)
    const tokenYData = tokenMetadata.get(poolView.token_y)
    const tokenXDecimals = tokenXData?.decimals ?? 8
    const tokenYDecimals = tokenYData?.decimals ?? 8

    const poolTokens = [
      buildPositionValue(
        poolView.token_x,
        prorateRawAmount(poolView.token_x_reserve, userLpAmount, totalLpSupply),
        tokenXDecimals,
        tokenXData?.priceUsd,
      ),
      buildPositionValue(
        poolView.token_y,
        prorateRawAmount(poolView.token_y_reserve, userLpAmount, totalLpSupply),
        tokenYDecimals,
        tokenYData?.priceUsd,
      ),
    ].filter((token) => token.amount.amount !== '0')

    if (!poolTokens.length) continue

    const poolStats = poolStatsMap.get(lpTokenId)
    const usdValue = prorateDecimalValue(
      poolStats?.stats?.tvl_usd,
      userLpAmount,
      totalLpSupply,
    )

    positions.push({
      positionKind: 'liquidity',
      liquidityModel: 'constant-product',
      platformId: 'mosaic',
      poolAddress: lpTokenId,
      feeBps: poolView.fee,
      lpTokenAmount: userLpAmount,
      poolTokens,
      ...(poolStats?.stats?.apr_fees !== undefined && {
        liquidityApy: poolStats.stats.apr_fees.toString(),
      }),
      ...(usdValue !== undefined && { usdValue }),
    })
  }

  return positions
}

async function getFarmPositions(
  userStakeInfos: readonly MosaicUserStakeInfoView[],
  lpMetadataMap: ReadonlyMap<string, MosaicIndexerMetadata>,
  farmStatsMap: ReadonlyMap<string, MosaicFarmStatsEntry>,
  plugins: AptosPlugins,
): Promise<StakingDefiPosition[]> {
  if (!userStakeInfos.length) return []

  const activeFarmAddresses = uniqueStrings(
    userStakeInfos.map((stakeInfo) => normalizeAddress(stakeInfo.pool_address)),
  )

  const poolStatesResult = await view<MosaicFarmPoolStateView[]>(
    plugins,
    `${MOSAIC_STAKING}::staking_pool::get_pool_states`,
    [activeFarmAddresses],
  )
  const poolStates =
    (poolStatesResult[0] as MosaicFarmPoolStateView[] | undefined) ?? []

  const poolStateByFarmAddress = new Map<string, MosaicFarmPoolStateView>()
  poolStates.forEach((poolState, index) => {
    const farmAddress = activeFarmAddresses[index]
    if (farmAddress) {
      poolStateByFarmAddress.set(farmAddress, poolState)
    }
  })

  const rewardTokenIds = uniqueStrings(
    poolStates.map((poolState) => poolState.reward_token.inner),
  )
  const rewardTokenMetadata = await plugins.tokens.fetchMany(rewardTokenIds)

  const positions: StakingDefiPosition[] = []

  for (const stakeInfo of userStakeInfos) {
    if (stakeInfo.amount === '0' && stakeInfo.pending_rewards === '0') continue

    const farmAddress = normalizeAddress(stakeInfo.pool_address)
    const poolState = poolStateByFarmAddress.get(farmAddress)
    if (!poolState) continue

    const lpTokenId = normalizeAddress(poolState.stake_token.inner)
    const lpMetadata = lpMetadataMap.get(lpTokenId)
    if (!lpMetadata) continue

    const totalStakedUsd =
      farmStatsMap.get(farmAddress)?.stats?.total_staked_usd
    const usdValue = prorateDecimalValue(
      totalStakedUsd,
      stakeInfo.amount,
      poolState.total_staked,
    )

    const rewardTokenId = poolState.reward_token.inner
    const rewardTokenData = rewardTokenMetadata.get(rewardTokenId)
    const rewardDecimals = rewardTokenData?.decimals ?? 8
    const farmApr = farmStatsMap.get(farmAddress)?.stats?.apr
    const rewards =
      stakeInfo.pending_rewards === '0'
        ? undefined
        : [
            buildPositionValue(
              rewardTokenId,
              stakeInfo.pending_rewards,
              rewardDecimals,
              rewardTokenData?.priceUsd,
            ),
          ]

    positions.push({
      platformId: 'mosaic',
      positionKind: 'staking',
      staked: [
        {
          amount: {
            token: lpTokenId,
            amount: stakeInfo.amount,
            decimals: (lpMetadata.decimals ?? 6).toString(),
          },
        },
      ],
      ...(farmApr !== undefined && {
        apy: farmApr.toString(),
      }),
      ...(stakeInfo.unlock_time !== '0' && {
        lockedUntil: stakeInfo.unlock_time,
      }),
      ...(rewards !== undefined && { rewards }),
      ...(usdValue !== undefined && { totalStakedUsd: usdValue, usdValue }),
    })
  }

  return positions
}

async function getUserPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<UserDefiPosition[]> {
  const [poolStatsMap, farmStatsMap] = await Promise.all([
    getMosaicPoolStatsMap().catch(
      () => new Map<string, MosaicPoolStatsEntry>(),
    ),
    getMosaicFarmStatsMap().catch(
      () => new Map<string, MosaicFarmStatsEntry>(),
    ),
  ])

  const knownPoolIds = [...poolStatsMap.keys()]
  const knownFarmAddresses = [...farmStatsMap.keys()]

  const [userLpBalances, userStakeInfos] = await Promise.all([
    getUserLpBalances(address, knownPoolIds, plugins),
    getUserStakeInfos(knownFarmAddresses, address, plugins),
  ])

  if (!userLpBalances.size && !userStakeInfos.length) return []

  const directLpTokenIds = [...userLpBalances.keys()]
  const stakedLpTokenIds = uniqueStrings(
    userStakeInfos
      .map(
        (stakeInfo) =>
          farmStatsMap.get(normalizeAddress(stakeInfo.pool_address))?.metadata
            ?.stake_token,
      )
      .filter((tokenId): tokenId is string => tokenId !== undefined)
      .map(normalizeAddress),
  )
  const relevantLpTokenIds = uniqueStrings([
    ...directLpTokenIds,
    ...stakedLpTokenIds,
  ])

  const [poolViewMap, lpMetadataMap] = await Promise.all([
    getPoolViewMap(directLpTokenIds, plugins),
    getLpMetadataMap(relevantLpTokenIds, plugins),
  ])

  const [liquidityPositions, farmPositions] = await Promise.all([
    getDirectLiquidityPositions(
      userLpBalances,
      poolViewMap,
      lpMetadataMap,
      poolStatsMap,
      plugins,
    ),
    getFarmPositions(userStakeInfos, lpMetadataMap, farmStatsMap, plugins),
  ])

  return [...liquidityPositions, ...farmPositions]
}

async function getTvl(): Promise<string> {
  const response = await fetchJson<MosaicPoolStatsResponse>(
    `${MOSAIC_STATS_API}/pools`,
  )
  const tvl = (response.data?.pools ?? []).reduce(
    (sum, pool) => sum + (pool.stats?.tvl_usd ?? 0),
    0,
  )

  return tvl.toString()
}

async function getVolume(): Promise<string> {
  const response = await fetchJson<MosaicPoolStatsResponse>(
    `${MOSAIC_STATS_API}/pools`,
  )
  const volume = (response.data?.pools ?? []).reduce(
    (sum, pool) => sum + (pool.stats?.volume_24h_usd ?? 0),
    0,
  )

  return volume.toString()
}

export const mosaicIntegration: AptosIntegration = {
  platformId: 'mosaic',
  getUserPositions,
  getTvl,
  getVolume,
}

export default mosaicIntegration
