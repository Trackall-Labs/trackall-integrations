import type {
  AptosIntegration,
  AptosPlugins,
} from '../../../types/aptosIntegration'
import type { ConcentratedRangeLiquidityDefiPosition } from '../../../types/liquidity'
import type { UserDefiPosition } from '../../../types/position'

// Yuzu CLMM contract on Movement mainnet
const YUZU_CONTRACT =
  '0x46566b4a16a1261ab400ab5b9067de84ba152b5eb4016b217187f2a2ca980c5a' as const

export const testAddress =
  '0xdd284fb30311654251f1bc7ee9293962e1f28177534a56185ad5a553a72ed911'

// NFT manager account — all positions are stored in the liquidity_pool under this address
const NFT_MANAGER =
  '0x1d0434ae92598710f5ccbfbf51cf66cf2fe8ba8e77381bed92f45bb32d237bc2' as const

// Ticks are stored as u32 with an offset so all values are non-negative.
// real_tick = stored_tick - TICK_OFFSET  (TICK_OFFSET = MAX_TICK / 2 = 443636)
const TICK_OFFSET = 443636

// Description set by Yuzu on every pool's NFT collection
const YUZU_COLLECTION_DESCRIPTION = 'Yuzuswap liquidity position collection'

interface PoolView {
  pool_addr: string
  token_0: string
  token_1: string
  token_0_decimals: number
  token_1_decimals: number
  current_tick: number
  current_sqrt_price: string
  fee_rate: string
  tick_spacing: number
  reward_infos: Array<{
    token_metadata: { inner: string }
  }>
}

interface Position {
  tick_lower: number
  tick_upper: number
  liquidity: string
  tokens_owed_0: string
  tokens_owed_1: string
  reward_infos: Array<{
    reward_growth_inside_last: string
    amount_owed: string
  }>
}

interface TimingRecord {
  count: number
  totalMs: number
  maxMs: number
}

// Aptos addresses can appear with or without leading-zero padding.
// Normalize to full 64-char hex so comparisons are reliable.
function normalizeAddress(addr: string): string {
  return `0x${addr.slice(2).padStart(64, '0').toLowerCase()}`
}

function tickToAdjustedPrice(
  storedTick: number,
  dec0: number,
  dec1: number,
): number {
  const realTick = storedTick - TICK_OFFSET
  return 1.0001 ** realTick * 10 ** (dec0 - dec1)
}

interface UserNftPosition {
  poolAddress: string
  positionId: number
}

async function fetchUserNftPositions(
  address: string,
  indexerUrl: string,
): Promise<UserNftPosition[]> {
  const query = `{
    current_token_ownerships_v2(where: {
      owner_address: {_eq: "${address}"},
      amount: {_gt: "0"}
    }) {
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

  const json = (await response.json()) as {
    data?: {
      current_token_ownerships_v2?: Array<{
        current_token_data: {
          token_name: string
          current_collection: {
            creator_address: string
            description: string
          }
        } | null
      }>
    }
  }

  const ownerships = json.data?.current_token_ownerships_v2 ?? []
  const positions: UserNftPosition[] = []

  for (const ownership of ownerships) {
    const td = ownership.current_token_data
    if (!td) continue

    const coll = td.current_collection
    if (!coll || coll.description !== YUZU_COLLECTION_DESCRIPTION) continue

    const positionId = Number(td.token_name)
    if (!Number.isInteger(positionId) || positionId < 0) continue

    positions.push({
      poolAddress: normalizeAddress(coll.creator_address),
      positionId,
    })
  }

  return positions
}

async function getUserPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<UserDefiPosition[]> {
  const { client, tokens } = plugins
  const timings = new Map<string, TimingRecord>()
  const shouldLogTimings = process.env.MOVEMENT_YUZU_TIMING_LOGS !== '0'

  const runTimed = async <T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const start = performance.now()
    try {
      return await operation()
    } finally {
      const elapsed = performance.now() - start
      const entry = timings.get(name) ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
      }
      entry.count += 1
      entry.totalMs += elapsed
      entry.maxMs = Math.max(entry.maxMs, elapsed)
      timings.set(name, entry)
    }
  }

  // 1. Discover user's Yuzu position NFTs via the indexer (fast, single query)
  const indexerUrl = (
    client.config.indexerConfig as
      | {
          indexerUrl: string
        }
      | null
      | undefined
  )?.indexerUrl

  if (indexerUrl === undefined) return []

  const nftPositions = await runTimed('fetchUserNftPositions', () =>
    fetchUserNftPositions(address, indexerUrl),
  )
  if (!nftPositions.length) return []

  // 2. Fetch pool views for only the relevant pools (token info, current tick)
  const uniquePoolAddresses = [
    ...new Set(nftPositions.map((p) => p.poolAddress)),
  ]

  const poolViewsResult = await runTimed(
    'client.view/get_pool_views_by_addresses',
    () =>
      client.view({
        payload: {
          function: `${YUZU_CONTRACT}::liquidity_pool::get_pool_views_by_addresses`,
          typeArguments: [],
          functionArguments: [uniquePoolAddresses],
        },
      }),
  )

  const poolViewMap = new Map<string, PoolView>()
  for (const pv of poolViewsResult[0] as PoolView[]) {
    poolViewMap.set(normalizeAddress(pv.pool_addr), pv)
  }

  // 3. Fetch position details and token amounts for all owned positions in parallel.
  // Positions are stored in the liquidity_pool under the NFT_MANAGER address (not the user's).
  const positionDetails = await Promise.allSettled(
    nftPositions.map(async ({ poolAddress, positionId }) => {
      const [positionResult, tokenAmountsResult] = await Promise.all([
        runTimed(
          `client.view/get_position_with_pending_fees_and_rewards:${positionId}`,
          () =>
            client.view({
              payload: {
                function: `${YUZU_CONTRACT}::liquidity_pool::get_position_with_pending_fees_and_rewards`,
                typeArguments: [],
                functionArguments: [
                  NFT_MANAGER,
                  poolAddress,
                  positionId.toString(),
                ],
              },
            }),
        ),
        runTimed(`client.view/get_position_token_amounts:${positionId}`, () =>
          client.view({
            payload: {
              function: `${YUZU_CONTRACT}::position_nft_manager::get_position_token_amounts`,
              typeArguments: [],
              functionArguments: [poolAddress, positionId.toString()],
            },
          }),
        ),
      ])

      const position = positionResult[0] as Position
      const [amount0, amount1] = tokenAmountsResult as [string, string]

      return { poolAddress, positionId, position, amount0, amount1 }
    }),
  )

  // 4. Collect token IDs and filter valid positions
  const tokenIds = new Set<string>()
  const validPositions: Array<{
    poolAddress: string
    position: Position
    amount0: string
    amount1: string
    poolView: PoolView
  }> = []

  for (const detail of positionDetails) {
    if (detail.status === 'rejected') continue

    const { poolAddress, position, amount0, amount1 } = detail.value
    if (position.liquidity === '0') continue

    const poolView = poolViewMap.get(poolAddress)
    if (!poolView) continue

    tokenIds.add(poolView.token_0)
    tokenIds.add(poolView.token_1)
    for (const rewardInfo of poolView.reward_infos) {
      tokenIds.add(rewardInfo.token_metadata.inner)
    }

    validPositions.push({ poolAddress, position, amount0, amount1, poolView })
  }

  if (!validPositions.length) return []

  // 5. Fetch all token metadata in one batch
  const tokenMetadataMap = await runTimed('tokens.fetchMany', () =>
    tokens.fetchMany([...tokenIds]),
  )

  // 6. Build ConcentratedRangeLiquidityDefiPosition for each valid position
  const result: UserDefiPosition[] = []

  for (const {
    poolAddress,
    position,
    amount0,
    amount1,
    poolView,
  } of validPositions) {
    const token0Meta = tokenMetadataMap.get(poolView.token_0)
    const token1Meta = tokenMetadataMap.get(poolView.token_1)

    const dec0 = poolView.token_0_decimals
    const dec1 = poolView.token_1_decimals
    const token0PriceUsd = token0Meta?.priceUsd
    const token1PriceUsd = token1Meta?.priceUsd

    // Match the other concentrated-liquidity integrations: these fields carry
    // the normalized token0/token1 pool price derived from ticks.
    const toPoolPrice = (storedTick: number): string =>
      tickToAdjustedPrice(storedTick, dec0, dec1).toString()

    const currentPriceUsd = toPoolPrice(poolView.current_tick)
    const lowerPriceUsd = toPoolPrice(position.tick_lower)
    const upperPriceUsd = toPoolPrice(position.tick_upper)

    // Position is active when current tick is within [tick_lower, tick_upper)
    const isActive =
      position.tick_lower <= poolView.current_tick &&
      poolView.current_tick < position.tick_upper

    // USD values of each token amount
    const amount0Human = Number(amount0) / 10 ** dec0
    const amount1Human = Number(amount1) / 10 ** dec1
    const usdValue0 =
      token0PriceUsd !== undefined ? amount0Human * token0PriceUsd : undefined
    const usdValue1 =
      token1PriceUsd !== undefined ? amount1Human * token1PriceUsd : undefined
    const totalUsdValue =
      usdValue0 !== undefined && usdValue1 !== undefined
        ? usdValue0 + usdValue1
        : usdValue0 !== undefined
          ? usdValue0
          : usdValue1

    // Pending fee rewards (tokens_owed accumulate as uncollected trading fees)
    const feeRewards = []
    if (position.tokens_owed_0 !== '0') {
      const amt = Number(position.tokens_owed_0) / 10 ** dec0
      feeRewards.push({
        amount: {
          token: poolView.token_0,
          amount: position.tokens_owed_0,
          decimals: dec0.toString(),
        },
        ...(token0PriceUsd !== undefined && {
          priceUsd: token0PriceUsd.toString(),
        }),
        ...(token0PriceUsd !== undefined && {
          usdValue: (amt * token0PriceUsd).toString(),
        }),
      })
    }
    if (position.tokens_owed_1 !== '0') {
      const amt = Number(position.tokens_owed_1) / 10 ** dec1
      feeRewards.push({
        amount: {
          token: poolView.token_1,
          amount: position.tokens_owed_1,
          decimals: dec1.toString(),
        },
        ...(token1PriceUsd !== undefined && {
          priceUsd: token1PriceUsd.toString(),
        }),
        ...(token1PriceUsd !== undefined && {
          usdValue: (amt * token1PriceUsd).toString(),
        }),
      })
    }

    // Liquidity mining rewards from pool incentive programs
    const incentiveRewards = []
    for (let ri = 0; ri < position.reward_infos.length; ri++) {
      const rewardInfo = position.reward_infos[ri]
      if (!rewardInfo || rewardInfo.amount_owed === '0') continue

      const poolRewardInfo = poolView.reward_infos[ri]
      if (!poolRewardInfo) continue

      const rewardToken = poolRewardInfo.token_metadata.inner
      const rewardMeta = tokenMetadataMap.get(rewardToken)
      const rewardDec = rewardMeta?.decimals ?? 8
      const rewardPriceUsd = rewardMeta?.priceUsd
      const rewardAmountHuman = Number(rewardInfo.amount_owed) / 10 ** rewardDec

      incentiveRewards.push({
        amount: {
          token: rewardToken,
          amount: rewardInfo.amount_owed,
          decimals: rewardDec.toString(),
        },
        ...(rewardPriceUsd !== undefined && {
          priceUsd: rewardPriceUsd.toString(),
        }),
        ...(rewardPriceUsd !== undefined && {
          usdValue: (rewardAmountHuman * rewardPriceUsd).toString(),
        }),
      })
    }

    const allRewards = [...feeRewards, ...incentiveRewards]

    const positionResult: ConcentratedRangeLiquidityDefiPosition = {
      positionKind: 'liquidity',
      liquidityModel: 'concentrated-range',
      platformId: 'yuzu',
      poolAddress,
      isActive,
      lowerPriceUsd,
      upperPriceUsd,
      currentPriceUsd,
      feeBps: poolView.fee_rate,
      poolTokens: [
        {
          amount: {
            token: poolView.token_0,
            amount: amount0,
            decimals: dec0.toString(),
          },
          ...(token0PriceUsd !== undefined && {
            priceUsd: token0PriceUsd.toString(),
          }),
          ...(usdValue0 !== undefined && { usdValue: usdValue0.toString() }),
        },
        {
          amount: {
            token: poolView.token_1,
            amount: amount1,
            decimals: dec1.toString(),
          },
          ...(token1PriceUsd !== undefined && {
            priceUsd: token1PriceUsd.toString(),
          }),
          ...(usdValue1 !== undefined && { usdValue: usdValue1.toString() }),
        },
      ],
      ...(totalUsdValue !== undefined && {
        usdValue: totalUsdValue.toString(),
      }),
      ...(allRewards.length > 0 && { rewards: allRewards }),
    }

    result.push(positionResult)
  }

  if (shouldLogTimings) {
    const rows = [...timings.entries()].map(([name, metric]) => ({
      name,
      count: metric.count,
      totalMs: metric.totalMs,
      avgMs: metric.totalMs / metric.count,
      maxMs: metric.maxMs,
    }))

    rows.sort((a, b) => b.totalMs - a.totalMs)
    console.log('\n[yuzu timing]')
    for (const row of rows) {
      console.log(
        `${row.name}: count=${row.count} avg=${row.avgMs.toFixed(2)}ms total=${row.totalMs.toFixed(2)}ms max=${row.maxMs.toFixed(2)}ms`,
      )
    }
  }

  return result
}

export const yuzuIntegration: AptosIntegration = {
  platformId: 'yuzu',
  getUserPositions,
}

export default yuzuIntegration
