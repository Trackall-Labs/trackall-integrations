import type {
  AptosIntegration,
  AptosPlugins,
} from '../../../types/aptosIntegration'
import type {
  LendingDefiPosition,
  LendingSuppliedAsset,
} from '../../../types/lending'
import type { ConstantProductLiquidityDefiPosition } from '../../../types/liquidity'
import type { UserDefiPosition } from '../../../types/position'
import type { PositionValue } from '../../../types/positionCommon'

const CANOPY_CORE_VAULTS =
  '0xb10bd32b3979c9d04272c769d9ef52afbc6edc4bf03982a9e326b96ac25e7f2d' as const
const CANOPY_REWARDS_VIEW =
  '0x707462571715301b063d79c2cdb57c3bd1cfe2189889793b00077ceed86e0219' as const
const CANOPY_GRAPHQL_URL =
  'https://rwf3uyiewzdnhavtega3imkynm.appsync-api.us-east-1.amazonaws.com/graphql' as const
const CANOPY_GRAPHQL_API_KEY = 'da2-lcrfa5vgu5dkdct5ddrckpilj4' as const
const MOVEMENT_INDEXER_URL =
  'https://indexer.mainnet.movementnetwork.xyz/v1/graphql' as const
const MOVE_TOKEN_ID =
  '0x000000000000000000000000000000000000000000000000000000000000000a' as const
const CANOPY_CHAIN_ID = 126
const CANOPY_PAGE_LIMIT = 500
const CANOPY_VAULTS_PAGE_SIZE = 200

export const testAddress =
  '0xdd284fb30311654251f1bc7ee9293962e1f28177534a56185ad5a553a72ed911'

interface GraphqlResponse<T> {
  data?: T
  errors?: Array<{
    message?: string
  }>
}

interface CanopyMetadataResponse {
  listCanopyMetadata?: {
    items?: CanopyMetadataItem[]
  }
}

interface CanopyGlobalTokensResponse {
  listGlobalTokens?: {
    items?: CanopyGlobalToken[]
  }
}

interface CanopyMetadataItem {
  networkAddress: string
  displayName: string
  investmentType: string
  description?: string | null
  labels?: string[] | null
  rewardPools?: string[] | null
  token0?: string | null
  token1?: string | null
  decimals0?: number | null
  decimals1?: number | null
  apr?: number | null
  rewardApr?: number | null
  paused?: boolean | null
  isHidden?: boolean | null
  additionalMetadata?: CanopyAdditionalMetadata[] | null
}

interface CanopyAdditionalMetadata {
  key: string
  item: string
}

interface CanopyGlobalToken {
  address: string
  coinAddress?: string | null
  displayName?: string | null
  fullName?: string | null
  decimals?: number | null
  price?: number | null
  symbol?: string | null
}

interface CanopyVaultPage {
  vaults: CanopyVaultView[]
  total_count: string
}

interface CanopyVaultView {
  asset_address: string
  asset_name: string
  decimals: number
  paired_coin_type?: {
    vec?: string[]
  }
  shares_address: string
  shares_name: string
  strategies: CanopyVaultStrategyView[]
  total_asset: string
  total_debt: string
  total_idle: string
  total_shares: string
  vault_address: string
}

interface CanopyVaultStrategyView {
  asset_address: string
  concrete_address: string
  current_vault_debt: string
  debt_limit: string
  decimals: number
  last_report: string
  shares_address: string
  strategy_address: string
  total_asset: string
  total_debt: string
  total_idle: string
  total_loss: string
  total_profit: string
  total_shares: string
  vault_address: string
}

interface CurrentFungibleAssetBalance {
  amount: string | number
  asset_type_v2?: string | null
  metadata?: {
    decimals?: number | null
    name?: string | null
    symbol?: string | null
  } | null
}

interface CurrentFungibleAssetBalancesResponse {
  current_fungible_asset_balances?: CurrentFungibleAssetBalance[]
}

interface RewardsUserPoolPosition {
  effective_staked_amount: string
  is_subscribed: boolean
  pool: {
    inner: string
  }
  pool_staking_token: {
    inner: string
  }
  rewards: Array<{
    earned_amount: string
    reward_token: {
      inner: string
    }
  }>
}

interface MetadataLookup {
  cvSymbol?: string
  destinationType?: string
  market?: string
  wrapperCoinType?: string
  asset0?: string
  asset1?: string
  type?: string
}

interface TokenLookupEntry {
  tokenId: string
  decimals: number
  name?: string
  symbol?: string
  priceUsd?: number
}

type CanopyLendingPosition = LendingDefiPosition & {
  vaultAddress: string
  vaultName: string
  shareTokenAddress: string
}

type CanopyLiquidityPosition = ConstantProductLiquidityDefiPosition & {
  vaultAddress: string
  vaultName: string
  shareTokenAddress: string
}

function normalizeAddress(address: string): string {
  if (!address.startsWith('0x')) return address.toLowerCase()
  return `0x${address.slice(2).padStart(64, '0').toLowerCase()}`
}

function normalizeNumberish(value: string | number | bigint): string {
  return typeof value === 'string' ? value : value.toString()
}

function divideRawAmount(rawAmount: string, decimals: number): number {
  return Number(rawAmount) / 10 ** decimals
}

function buildUsdValue(
  rawAmount: string,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  return (divideRawAmount(rawAmount, decimals) * priceUsd).toString()
}

function mapAdditionalMetadata(
  entries: readonly CanopyAdditionalMetadata[] | null | undefined,
): MetadataLookup {
  const lookup: MetadataLookup = {}

  for (const entry of entries ?? []) {
    if (entry.key === 'cvSymbol') lookup.cvSymbol = entry.item
    if (entry.key === 'destinationType') lookup.destinationType = entry.item
    if (entry.key === 'market') lookup.market = entry.item
    if (entry.key === 'wrapperCoinType') lookup.wrapperCoinType = entry.item
    if (entry.key === 'asset0') lookup.asset0 = entry.item
    if (entry.key === 'asset1') lookup.asset1 = entry.item
    if (entry.key === 'type') lookup.type = entry.item
  }

  return lookup
}

function getMetadataTokenIds(
  metadata: CanopyMetadataItem,
  lookup: MetadataLookup,
): string[] {
  return [
    metadata.token0,
    metadata.token1,
    lookup.asset0,
    lookup.asset1,
    lookup.market,
    ...(metadata.rewardPools ?? []).map((pool) => pool),
  ].flatMap((value) => (value ? [value] : []))
}

function classifyVaultPosition(
  metadata: CanopyMetadataItem,
  lookup: MetadataLookup,
): 'lending' | 'liquidity' {
  const investmentType = metadata.investmentType.toLowerCase()
  const destinationType = lookup.destinationType?.toLowerCase()
  const canType = lookup.type?.toLowerCase()

  if (
    investmentType === 'satay_echelon' ||
    investmentType === 'satay_moveposition' ||
    destinationType === 'satay_echelon' ||
    destinationType === 'satay_moveposition'
  ) {
    return 'lending'
  }

  if (
    investmentType === 'satay_meridian_stable_pool' ||
    investmentType === 'satay_ls05' ||
    investmentType === 'ichi_vault_liquidswap' ||
    destinationType === 'satay_meridian_stable_pool' ||
    destinationType === 'satay_ls05'
  ) {
    return 'liquidity'
  }

  if (
    investmentType === 'cornucopia_deployer' ||
    canType === 'sadb' ||
    canType === 'dadb'
  ) {
    if (
      destinationType === 'satay_echelon' ||
      destinationType === 'satay_moveposition'
    ) {
      return 'lending'
    }
    return 'liquidity'
  }

  return metadata.token1 ? 'liquidity' : 'lending'
}

async function fetchGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T | undefined> {
  const response = await fetch(CANOPY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CANOPY_GRAPHQL_API_KEY,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Canopy GraphQL request failed: ${response.status} ${response.statusText}`,
    )
  }

  const json = (await response.json()) as GraphqlResponse<T>
  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message || 'Canopy GraphQL request failed')
  }

  return json.data
}

async function fetchCanopyMetadata(): Promise<CanopyMetadataItem[]> {
  const query = `
    query GetCanopyMetadata($chainId: Int!, $limit: Int) {
      listCanopyMetadata(filter: {chainId: {eq: $chainId}}, limit: $limit) {
        items {
          networkAddress
          displayName
          investmentType
          description
          labels
          rewardPools
          additionalMetadata {
            item
            key
          }
          paused
          isHidden
          token0
          token1
          decimals0
          decimals1
          apr
          rewardApr
        }
      }
    }
  `

  const data = await fetchGraphql<CanopyMetadataResponse>(query, {
    chainId: CANOPY_CHAIN_ID,
    limit: CANOPY_PAGE_LIMIT,
  })

  return data?.listCanopyMetadata?.items ?? []
}

async function fetchCanopyGlobalTokens(): Promise<CanopyGlobalToken[]> {
  const query = `
    query GetGlobalTokens($chainId: Int, $limit: Int) {
      listGlobalTokens(
        filter: {chainId: {eq: $chainId}, networkType: {ne: "evm"}}
        limit: $limit
      ) {
        items {
          address
          coinAddress
          displayName
          fullName
          decimals
          price
          symbol
        }
      }
    }
  `

  const data = await fetchGraphql<CanopyGlobalTokensResponse>(query, {
    chainId: CANOPY_CHAIN_ID,
    limit: CANOPY_PAGE_LIMIT,
  })

  return data?.listGlobalTokens?.items ?? []
}

async function fetchUserShareBalances(
  address: string,
): Promise<CurrentFungibleAssetBalance[]> {
  const query = `
    query GetUserBalances($owner: String!) {
      current_fungible_asset_balances(
        where: {
          owner_address: {_eq: $owner}
          amount: {_gt: "0"}
        }
      ) {
        amount
        asset_type_v2
        metadata {
          name
          symbol
          decimals
        }
      }
    }
  `

  const response = await fetch(MOVEMENT_INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: {
        owner: address,
      },
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Movement indexer request failed: ${response.status} ${response.statusText}`,
    )
  }

  const json =
    (await response.json()) as GraphqlResponse<CurrentFungibleAssetBalancesResponse>
  if (json.errors?.length) {
    throw new Error(
      json.errors[0]?.message || 'Movement indexer request failed',
    )
  }

  return json.data?.current_fungible_asset_balances ?? []
}

async function fetchVaultRegistry(
  plugins: AptosPlugins,
): Promise<CanopyVaultView[]> {
  const vaults: CanopyVaultView[] = []
  let offset = 0
  let totalCount = Number.POSITIVE_INFINITY

  while (offset < totalCount) {
    const [page] = (await plugins.client.view({
      payload: {
        function: `${CANOPY_CORE_VAULTS}::vault::vaults_view`,
        typeArguments: [],
        functionArguments: [
          offset.toString(),
          CANOPY_VAULTS_PAGE_SIZE.toString(),
        ],
      },
    })) as [CanopyVaultPage]

    vaults.push(...page.vaults)
    totalCount = Number(page.total_count)
    offset += page.vaults.length

    if (page.vaults.length === 0) break
  }

  return vaults
}

async function fetchRewardPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<RewardsUserPoolPosition[]> {
  const [positions] = (await plugins.client.view({
    payload: {
      function: `${CANOPY_REWARDS_VIEW}::rewards_view::get_user_pool_positions`,
      typeArguments: [],
      functionArguments: [address, null, null],
    },
  })) as [RewardsUserPoolPosition[]]

  return positions ?? []
}

async function buildTokenLookup(
  tokenIds: readonly string[],
  plugins: AptosPlugins,
): Promise<Map<string, TokenLookupEntry>> {
  const normalizedIds = [...new Set(tokenIds.map(normalizeAddress))]
  const globalTokens = await fetchCanopyGlobalTokens().catch(() => [])

  const lookup = new Map<string, TokenLookupEntry>()

  for (const token of globalTokens) {
    const address = normalizeAddress(token.address)
    if (!normalizedIds.includes(address)) continue
    const fullName = token.fullName ?? token.displayName

    lookup.set(address, {
      tokenId: token.address,
      decimals: token.decimals ?? 8,
      ...(fullName && { name: fullName }),
      ...(token.symbol && { symbol: token.symbol }),
      ...(token.price !== undefined &&
        token.price !== null && {
          priceUsd: token.price,
        }),
    })
  }

  const missingIds = normalizedIds.filter((id) => !lookup.has(id))
  if (missingIds.length === 0) return lookup

  const pluginResults = await plugins.tokens.fetchMany(missingIds)
  for (const [tokenId, token] of pluginResults) {
    if (!token) continue

    lookup.set(normalizeAddress(tokenId), {
      tokenId,
      decimals: token.decimals,
      ...(token.name && { name: token.name }),
      ...(token.symbol && { symbol: token.symbol }),
      ...(token.priceUsd !== undefined && { priceUsd: token.priceUsd }),
    })
  }

  return lookup
}

function buildPositionValue(
  token: string,
  rawAmount: string,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const usdValue = buildUsdValue(rawAmount, decimals, priceUsd)

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

function getVaultRewardValues(
  shareAddress: string,
  rewardPositions: readonly RewardsUserPoolPosition[],
  tokenById: ReadonlyMap<string, TokenLookupEntry>,
): PositionValue[] {
  const rewards: PositionValue[] = []

  for (const position of rewardPositions) {
    if (normalizeAddress(position.pool_staking_token.inner) !== shareAddress)
      continue

    for (const reward of position.rewards) {
      if (reward.earned_amount === '0') continue

      const rewardTokenId = normalizeAddress(reward.reward_token.inner)
      const token = tokenById.get(rewardTokenId)
      const decimals = token?.decimals ?? 8
      const canonicalTokenId = token?.tokenId ?? reward.reward_token.inner

      rewards.push(
        buildPositionValue(
          canonicalTokenId,
          reward.earned_amount,
          decimals,
          token?.priceUsd,
        ),
      )
    }
  }

  return rewards
}

async function buildVaultPosition(
  shareBalance: CurrentFungibleAssetBalance,
  vault: CanopyVaultView,
  metadata: CanopyMetadataItem | undefined,
  rewardPositions: readonly RewardsUserPoolPosition[],
  tokenById: ReadonlyMap<string, TokenLookupEntry>,
  plugins: AptosPlugins,
): Promise<UserDefiPosition | undefined> {
  const shareAmount = normalizeNumberish(shareBalance.amount)
  if (shareAmount === '0') return undefined

  const [underlyingAmount] = (await plugins.client.view({
    payload: {
      function: `${CANOPY_CORE_VAULTS}::vault::shares_to_amount`,
      typeArguments: [],
      functionArguments: [vault.vault_address, shareAmount],
    },
  })) as [string]

  const metadataLookup = mapAdditionalMetadata(metadata?.additionalMetadata)
  const positionType = classifyVaultPosition(
    metadata ?? {
      networkAddress: vault.vault_address,
      displayName: vault.shares_name,
      investmentType: 'satay_echelon',
    },
    metadataLookup,
  )

  const baseTokenId = normalizeAddress(vault.asset_address)
  const baseToken = tokenById.get(baseTokenId)
  const baseDecimals = baseToken?.decimals ?? vault.decimals
  const baseTokenCanonicalId = baseToken?.tokenId ?? vault.asset_address
  const baseValue = buildPositionValue(
    baseTokenCanonicalId,
    underlyingAmount,
    baseDecimals,
    baseToken?.priceUsd,
  )

  const rewards = getVaultRewardValues(
    normalizeAddress(vault.shares_address),
    rewardPositions,
    tokenById,
  )

  const apr =
    metadata?.apr !== undefined && metadata.apr !== null
      ? (metadata.apr / 100).toString()
      : undefined
  const rewardApr =
    metadata?.rewardApr !== undefined && metadata.rewardApr !== null
      ? (metadata.rewardApr / 100).toString()
      : undefined
  const usdValue =
    baseValue.usdValue ??
    buildUsdValue(underlyingAmount, baseDecimals, baseToken?.priceUsd)

  if (positionType === 'lending') {
    const supplied: LendingSuppliedAsset[] = [
      {
        ...baseValue,
        ...(apr !== undefined && { supplyRate: apr }),
      },
    ]

    const position: CanopyLendingPosition = {
      positionKind: 'lending',
      platformId: 'canopy',
      supplied,
      ...(usdValue !== undefined && { usdValue }),
      ...(rewards.length > 0 && { rewards }),
      vaultAddress: vault.vault_address,
      vaultName: metadata?.displayName ?? vault.shares_name,
      shareTokenAddress: vault.shares_address,
    }

    return position
  }

  const poolTokens: PositionValue[] = [baseValue]
  const secondTokenId = metadataLookup.asset1
    ? normalizeAddress(metadataLookup.asset1)
    : metadata?.token1
      ? normalizeAddress(metadata.token1)
      : undefined

  if (secondTokenId && secondTokenId !== baseTokenId) {
    const secondToken = tokenById.get(secondTokenId)
    if (secondToken) {
      poolTokens.push(
        buildPositionValue(
          secondToken.tokenId,
          '0',
          secondToken.decimals,
          secondToken.priceUsd,
        ),
      )
    }
  }

  const position: CanopyLiquidityPosition = {
    positionKind: 'liquidity',
    liquidityModel: 'constant-product',
    platformId: 'canopy',
    poolTokens,
    poolAddress: vault.vault_address,
    ...(apr !== undefined &&
      rewardApr !== undefined && {
        liquidityApy: (Number(apr) + Number(rewardApr)).toString(),
      }),
    ...(apr !== undefined &&
      rewardApr === undefined && {
        liquidityApy: apr,
      }),
    ...(usdValue !== undefined && { usdValue }),
    ...(rewards.length > 0 && { rewards }),
    vaultAddress: vault.vault_address,
    vaultName: metadata?.displayName ?? vault.shares_name,
    shareTokenAddress: vault.shares_address,
  }

  return position
}

async function getUserPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<UserDefiPosition[]> {
  const normalizedAddress = normalizeAddress(address)

  const [vaultRegistry, canopyMetadata, shareBalances] = await Promise.all([
    fetchVaultRegistry(plugins),
    fetchCanopyMetadata().catch(() => []),
    fetchUserShareBalances(normalizedAddress),
  ])

  const vaultByShareAddress = new Map<string, CanopyVaultView>(
    vaultRegistry.map(
      (vault) => [normalizeAddress(vault.shares_address), vault] as const,
    ),
  )
  const metadataByVaultAddress = new Map<string, CanopyMetadataItem>(
    canopyMetadata.map(
      (item) => [normalizeAddress(item.networkAddress), item] as const,
    ),
  )

  const canopyShareBalances = shareBalances.filter((balance) => {
    const shareAddress = balance.asset_type_v2
    if (!shareAddress) return false
    return vaultByShareAddress.has(normalizeAddress(shareAddress))
  })

  if (canopyShareBalances.length === 0) return []

  const tokenIds = [
    ...vaultRegistry.flatMap((vault) => {
      const metadata = metadataByVaultAddress.get(
        normalizeAddress(vault.vault_address),
      )

      return [
        vault.asset_address,
        vault.shares_address,
        ...((metadata
          ? getMetadataTokenIds(
              metadata,
              mapAdditionalMetadata(metadata.additionalMetadata),
            )
          : []) as string[]),
      ]
    }),
    ...canopyShareBalances.flatMap((balance) =>
      balance.asset_type_v2 ? [balance.asset_type_v2] : [],
    ),
    MOVE_TOKEN_ID,
  ]

  const [tokenById, rewardPositions] = await Promise.all([
    buildTokenLookup(tokenIds, plugins),
    fetchRewardPositions(normalizedAddress, plugins).catch(() => []),
  ])

  const positions = await Promise.all(
    canopyShareBalances.map(async (shareBalance) => {
      const shareAddress = normalizeAddress(shareBalance.asset_type_v2 || '')
      const vault = vaultByShareAddress.get(shareAddress)
      if (!vault) return undefined

      const metadata = metadataByVaultAddress.get(
        normalizeAddress(vault.vault_address),
      )
      return buildVaultPosition(
        shareBalance,
        vault,
        metadata,
        rewardPositions,
        tokenById,
        plugins,
      )
    }),
  )

  return positions.flatMap((position) => (position ? [position] : []))
}

export const canopyIntegration: AptosIntegration = {
  platformId: 'canopy',
  getUserPositions,
}

export default canopyIntegration
