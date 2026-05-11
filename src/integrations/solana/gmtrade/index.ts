import { createHash } from 'node:crypto'
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type {
  AccountsMap,
  ConstantProductLiquidityDefiPosition,
  MaybeSolanaAccount,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  TradingDefiPosition,
  TradingOrder,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'
import gmsolLiquidityProviderIdl from './idls/gmsol_liquidity_provider.json'
import gmsolStoreIdl from './idls/gmsol_store.json'

const GMTRADE_STORE_PROGRAM_ID = 'Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo'
const GMTRADE_LP_PROGRAM_ID = 'LPMWczEVgXyQ3979XaqqEttanCXmYGvtJqPVtw1PvC8'
const POSITION_OWNER_OFFSET = 56
const ACTION_OWNER_OFFSET = 88
const LP_POSITION_OWNER_OFFSET = 8
const PRICE_DECIMALS = 20
const PENDING_ACTION_STATE = 0
const POSITION_KIND_LONG = 1
const POSITION_KIND_SHORT = 2
const ORDER_SIDE_LONG = 0
const ONE_HOUR_IN_MS = 60 * 60 * 1000
const ORDER_KIND_LABELS: Record<number, string> = {
  0: 'liquidation',
  1: 'auto-deleveraging',
  2: 'market-swap',
  3: 'market-increase',
  4: 'market-decrease',
  5: 'limit-swap',
  6: 'limit-increase',
  7: 'limit-decrease',
  8: 'stop-loss-decrease',
}

type BigNumberish = bigint | number | string | { toString(): string }

type DecodedPosition = {
  store: PublicKey
  kind: number
  market_token: PublicKey
  collateral_token: PublicKey
  state: {
    size_in_tokens: BigNumberish
    collateral_amount: BigNumberish
    size_in_usd: BigNumberish
  }
}

type DecodedLpPosition = {
  owner: PublicKey
  controller: PublicKey
  lp_mint: PublicKey
  position_id: BigNumberish
  staked_amount: BigNumberish
  staked_value_usd: BigNumberish
  stake_start_time: BigNumberish
}

type DecodedOrder = {
  header: {
    action_state: number
    store: PublicKey
  }
  market_token: PublicKey
  params: {
    kind: number
    side: number
    collateral_token: PublicKey
    initial_collateral_delta_amount: BigNumberish
    size_delta_value: BigNumberish
    acceptable_price: BigNumberish
  }
}

type DecodedMarket = {
  store: PublicKey
  meta: {
    market_token_mint: PublicKey
    index_token_mint: PublicKey
    long_token_mint: PublicKey
    short_token_mint: PublicKey
  }
  state?: {
    pools?: {
      primary?: {
        pool?: {
          long_token_amount: BigNumberish
          short_token_amount: BigNumberish
        }
      }
    }
  }
}

type MarketInfo = {
  marketAddress: string
  store: string
  marketTokenMint: string
  indexTokenMint: string
  longTokenMint: string
  shortTokenMint: string
  primaryPoolLongAmountRaw: bigint
  primaryPoolShortAmountRaw: bigint
}

type Bucket = {
  store: string
  marketToken: string
  positions: NonNullable<TradingDefiPosition['positions']>
  buyOrders: TradingOrder[]
  sellOrders: TradingOrder[]
  usdValues: number[]
  positionAccounts: string[]
  orderAccounts: string[]
  orderKinds: string[]
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  GMTRADE_STORE_PROGRAM_ID,
  GMTRADE_LP_PROGRAM_ID,
] as const

const storeCoder = new BorshAccountsCoder(gmsolStoreIdl as unknown as Idl)
const lpCoder = new BorshAccountsCoder(
  gmsolLiquidityProviderIdl as unknown as Idl,
)
const STORE_POSITION_DISCRIMINATOR = accountDiscriminator('Position')
const LP_POSITION_DISCRIMINATOR = accountDiscriminator('Position')
const ORDER_DISCRIMINATOR = accountDiscriminator('Order')
const MARKET_DISCRIMINATOR = accountDiscriminator('Market')
const STORE_POSITION_DISCRIMINATOR_B64 = discriminatorBase64(
  STORE_POSITION_DISCRIMINATOR,
)
const LP_POSITION_DISCRIMINATOR_B64 = discriminatorBase64(
  LP_POSITION_DISCRIMINATOR,
)
const ORDER_DISCRIMINATOR_B64 = discriminatorBase64(ORDER_DISCRIMINATOR)
const MARKET_DISCRIMINATOR_B64 = discriminatorBase64(MARKET_DISCRIMINATOR)

function accountDiscriminator(accountName: string): Uint8Array {
  return createHash('sha256')
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8)
}

function discriminatorBase64(discriminator: Uint8Array): string {
  return Buffer.from(discriminator).toString('base64')
}

function toBigInt(value: BigNumberish): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  return BigInt(value.toString())
}

function divideToDecimalString(
  numerator: bigint,
  denominator: bigint,
  digits = 6,
): string {
  if (denominator === 0n) return '0'

  const integerPart = numerator / denominator
  const remainder = numerator % denominator
  if (digits <= 0 || remainder === 0n) {
    return integerPart.toString()
  }

  const scale = 10n ** BigInt(digits)
  const fractionalPart = ((remainder * scale) / denominator)
    .toString()
    .padStart(digits, '0')
    .replace(/0+$/, '')

  return fractionalPart.length > 0
    ? `${integerPart}.${fractionalPart}`
    : integerPart.toString()
}

function toScaledDecimal(value: bigint, decimals: number): string {
  return divideToDecimalString(value, 10n ** BigInt(decimals))
}

function decodeAccount<T>(
  accountCoder: BorshAccountsCoder,
  accountName: string,
  data: Uint8Array,
): T | null {
  try {
    return accountCoder.decode(accountName, Buffer.from(data)) as T
  } catch {
    return null
  }
}

function toAccountInfo(
  account: MaybeSolanaAccount | undefined,
): AccountInfo<Buffer> | null {
  if (!account?.exists) return null

  return {
    data: Buffer.from(account.data),
    owner: new PublicKey(account.programAddress),
    lamports: Number(account.lamports),
    executable: false,
    rentEpoch: 0,
  }
}

function buildPositionValue(
  token: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const usdValue =
    priceUsd !== undefined
      ? ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
      : undefined

  return {
    amount: {
      token,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function getOrCreateBucket(
  buckets: Map<string, Bucket>,
  store: string,
  marketToken: string,
): Bucket {
  const key = `${store}:${marketToken}`
  const existing = buckets.get(key)
  if (existing) return existing

  const bucket: Bucket = {
    store,
    marketToken,
    positions: [],
    buyOrders: [],
    sellOrders: [],
    usdValues: [],
    positionAccounts: [],
    orderAccounts: [],
    orderKinds: [],
  }
  buckets.set(key, bucket)

  return bucket
}

function addOrderKind(bucket: Bucket, kind: number) {
  const label = ORDER_KIND_LABELS[kind] ?? `unknown-${kind}`
  if (!bucket.orderKinds.includes(label)) {
    bucket.orderKinds.push(label)
  }
}

function tokenDecimals(
  mint: string,
  tokens: SolanaPlugins['tokens'],
  mintDecimalsMap: Map<string, number>,
): number {
  return tokens.get(mint)?.decimals ?? mintDecimalsMap.get(mint) ?? 0
}

function tokenPriceUsd(mint: string, tokens: SolanaPlugins['tokens']) {
  return tokens.get(mint)?.priceUsd
}

function mulDivFloor(
  value: bigint,
  multiplier: bigint,
  divisor: bigint,
): bigint {
  if (value <= 0n || multiplier <= 0n || divisor <= 0n) return 0n
  return (value * multiplier) / divisor
}

function readTokenAccountMint(data: Uint8Array): string | null {
  const buf = Buffer.from(data)
  if (buf.length < 32) return null
  return new PublicKey(buf.subarray(0, 32)).toBase58()
}

function readTokenAccountAmount(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < 72) return null
  return buf.readBigUInt64LE(64)
}

export const gmtradeIntegration: SolanaIntegration = {
  platformId: 'gmtrade',

  getUserPositions: async function* (
    address: string,
    { tokens }: SolanaPlugins,
  ): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = tokens.get(token)
        if (tokenData === undefined) return undefined
        if (tokenData.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    const phase0Map = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: GMTRADE_STORE_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: STORE_POSITION_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: POSITION_OWNER_OFFSET,
              bytes: address,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: GMTRADE_STORE_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: ORDER_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: ACTION_OWNER_OFFSET,
              bytes: address,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: GMTRADE_LP_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: LP_POSITION_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: LP_POSITION_OWNER_OFFSET,
              bytes: address,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: GMTRADE_STORE_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: MARKET_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: address,
        programId: TOKEN_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: address,
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]

    const decodedPositions: Array<{ address: string; data: DecodedPosition }> =
      []
    const decodedLpPositions: Array<{
      address: string
      data: DecodedLpPosition
    }> = []
    const decodedOrders: Array<{ address: string; data: DecodedOrder }> = []
    const decodedMarkets: MarketInfo[] = []
    const walletMarketTokenBalances = new Map<string, bigint>()

    for (const [accountAddress, account] of Object.entries(phase0Map)) {
      if (!account.exists) continue

      if (
        account.programAddress === TOKEN_PROGRAM_ID.toBase58() ||
        account.programAddress === TOKEN_2022_PROGRAM_ID.toBase58()
      ) {
        const mint = readTokenAccountMint(account.data)
        const amount = readTokenAccountAmount(account.data)
        if (!mint || amount === null || amount <= 0n) continue

        const existing = walletMarketTokenBalances.get(mint)
        walletMarketTokenBalances.set(
          mint,
          existing !== undefined ? existing + amount : amount,
        )
        continue
      }

      if (account.programAddress === GMTRADE_LP_PROGRAM_ID) {
        const lpPosition = decodeAccount<DecodedLpPosition>(
          lpCoder,
          'Position',
          account.data,
        )
        if (lpPosition) {
          decodedLpPositions.push({ address: accountAddress, data: lpPosition })
        }
        continue
      }

      const position = decodeAccount<DecodedPosition>(
        storeCoder,
        'Position',
        account.data,
      )
      if (position) {
        decodedPositions.push({ address: accountAddress, data: position })
        continue
      }

      const order = decodeAccount<DecodedOrder>(
        storeCoder,
        'Order',
        account.data,
      )
      if (order) {
        decodedOrders.push({ address: accountAddress, data: order })
        continue
      }

      const market = decodeAccount<DecodedMarket>(
        storeCoder,
        'Market',
        account.data,
      )
      if (market) {
        const primaryPoolLongAmountRaw = toBigInt(
          market.state?.pools?.primary?.pool?.long_token_amount ?? 0,
        )
        const primaryPoolShortAmountRaw = toBigInt(
          market.state?.pools?.primary?.pool?.short_token_amount ?? 0,
        )
        decodedMarkets.push({
          marketAddress: accountAddress,
          store: market.store.toBase58(),
          marketTokenMint: market.meta.market_token_mint.toBase58(),
          indexTokenMint: market.meta.index_token_mint.toBase58(),
          longTokenMint: market.meta.long_token_mint.toBase58(),
          shortTokenMint: market.meta.short_token_mint.toBase58(),
          primaryPoolLongAmountRaw,
          primaryPoolShortAmountRaw,
        })
      }
    }

    if (
      decodedPositions.length === 0 &&
      decodedLpPositions.length === 0 &&
      decodedOrders.length === 0 &&
      decodedMarkets.length === 0
    ) {
      return []
    }

    const marketByTokenMint = new Map(
      decodedMarkets.map((market) => [market.marketTokenMint, market] as const),
    )

    for (const mint of [...walletMarketTokenBalances.keys()]) {
      if (!marketByTokenMint.has(mint)) {
        walletMarketTokenBalances.delete(mint)
      }
    }

    const mintSet = new Set<string>()
    for (const { data } of decodedPositions) {
      mintSet.add(data.collateral_token.toBase58())
    }
    for (const { data } of decodedOrders) {
      mintSet.add(data.params.collateral_token.toBase58())
    }
    decodedMarkets.forEach((market) => {
      mintSet.add(market.marketTokenMint)
      mintSet.add(market.indexTokenMint)
      mintSet.add(market.longTokenMint)
      mintSet.add(market.shortTokenMint)
    })
    decodedLpPositions.forEach(({ data }) => {
      mintSet.add(data.lp_mint.toBase58())
    })

    const mintAddresses = [...mintSet]
    const mintAccountsMap: AccountsMap =
      mintAddresses.length > 0 ? yield mintAddresses : {}

    const mintDecimalsMap = new Map<string, number>()
    const mintSupplyMap = new Map<string, bigint>()
    for (const mintAddress of mintAddresses) {
      const token = tokens.get(mintAddress)
      if (token) {
        mintDecimalsMap.set(mintAddress, token.decimals)
      }

      const accountInfo = toAccountInfo(mintAccountsMap[mintAddress])
      if (!accountInfo) continue

      try {
        const mint = unpackMint(
          new PublicKey(mintAddress),
          accountInfo,
          accountInfo.owner,
        )
        mintDecimalsMap.set(mintAddress, mint.decimals)
        mintSupplyMap.set(mintAddress, mint.supply)
      } catch {
        // Keep fallback decimals for unknown mint layouts.
      }
    }

    const buckets = new Map<string, Bucket>()

    for (const {
      address: positionAddress,
      data: position,
    } of decodedPositions) {
      const sizeInUsdRaw = toBigInt(position.state.size_in_usd)
      const sizeInTokensRaw = toBigInt(position.state.size_in_tokens)
      const collateralAmountRaw = toBigInt(position.state.collateral_amount)

      if (
        sizeInUsdRaw <= 0n &&
        sizeInTokensRaw <= 0n &&
        collateralAmountRaw <= 0n
      ) {
        continue
      }

      const store = position.store.toBase58()
      const marketToken = position.market_token.toBase58()
      const collateralToken = position.collateral_token.toBase58()
      const collateralDecimals = tokenDecimals(
        collateralToken,
        tokens,
        mintDecimalsMap,
      )
      const collateralPrice = tokenPriceUsd(collateralToken, tokens)

      const bucket = getOrCreateBucket(buckets, store, marketToken)
      bucket.positionAccounts.push(positionAddress)

      const notionalUsd = toScaledDecimal(sizeInUsdRaw, PRICE_DECIMALS)
      const notionalUsdNumber = Number(notionalUsd)
      if (Number.isFinite(notionalUsdNumber)) {
        bucket.usdValues.push(notionalUsdNumber)
      }

      const side =
        position.kind === POSITION_KIND_LONG
          ? 'long'
          : position.kind === POSITION_KIND_SHORT
            ? 'short'
            : null

      bucket.positions.push({
        ...(side && { side }),
        notionalUsd,
        ...(collateralAmountRaw > 0n && {
          collateral: [
            buildPositionValue(
              collateralToken,
              collateralAmountRaw,
              collateralDecimals,
              collateralPrice,
            ),
          ],
        }),
      })
    }

    for (const { address: orderAddress, data: order } of decodedOrders) {
      if (order.header.action_state !== PENDING_ACTION_STATE) {
        continue
      }

      const store = order.header.store.toBase58()
      const marketToken = order.market_token.toBase58()
      const collateralToken = order.params.collateral_token.toBase58()
      const collateralAmountRaw = toBigInt(
        order.params.initial_collateral_delta_amount,
      )
      const collateralDecimals = tokenDecimals(
        collateralToken,
        tokens,
        mintDecimalsMap,
      )
      const collateralPrice = tokenPriceUsd(collateralToken, tokens)
      const acceptablePriceRaw = toBigInt(order.params.acceptable_price)

      const side: TradingOrder['side'] =
        order.params.side === ORDER_SIDE_LONG ? 'buy' : 'sell'

      const orderValue = buildPositionValue(
        collateralToken,
        collateralAmountRaw,
        collateralDecimals,
        collateralPrice,
      )

      const orderItem: TradingOrder = {
        side,
        // GMTrade order accounts expose collateral cleanly; use collateral-based
        // values for both legs in v1 and include richer context in meta.
        selling: orderValue,
        buying: orderValue,
        ...(acceptablePriceRaw > 0n && {
          limitPrice: toScaledDecimal(acceptablePriceRaw, PRICE_DECIMALS),
        }),
        status: 'open',
      }

      const bucket = getOrCreateBucket(buckets, store, marketToken)
      bucket.orderAccounts.push(orderAddress)
      addOrderKind(bucket, order.params.kind)
      if (side === 'buy') {
        bucket.buyOrders.push(orderItem)
      } else {
        bucket.sellOrders.push(orderItem)
      }

      const sizeDeltaUsd = toBigInt(order.params.size_delta_value)
      if (sizeDeltaUsd > 0n) {
        const sizeDeltaUsdNumber = Number(
          toScaledDecimal(sizeDeltaUsd, PRICE_DECIMALS),
        )
        if (Number.isFinite(sizeDeltaUsdNumber)) {
          bucket.usdValues.push(sizeDeltaUsdNumber)
        }
      }
    }

    const result: UserDefiPosition[] = []

    for (const bucket of buckets.values()) {
      if (
        bucket.positions.length === 0 &&
        bucket.buyOrders.length === 0 &&
        bucket.sellOrders.length === 0
      ) {
        continue
      }

      const position: TradingDefiPosition = {
        platformId: 'gmtrade',
        positionKind: 'trading',
        marketType: 'perp',
        marginEnabled: true,
        ...(bucket.positions.length > 0 && { positions: bucket.positions }),
        ...(bucket.buyOrders.length > 0 && { buyOrders: bucket.buyOrders }),
        ...(bucket.sellOrders.length > 0 && { sellOrders: bucket.sellOrders }),
        ...(bucket.usdValues.length > 0 && {
          usdValue: bucket.usdValues
            .reduce((sum, value) => sum + value, 0)
            .toString(),
        }),
        meta: {
          gmtrade: {
            store: bucket.store,
            marketToken: bucket.marketToken,
            positionAccounts: bucket.positionAccounts,
            orderAccounts: bucket.orderAccounts,
            orderKinds: bucket.orderKinds,
          },
        },
      }

      result.push(position)
    }

    for (const {
      address: lpPositionAddress,
      data: lpPosition,
    } of decodedLpPositions) {
      const lpMint = lpPosition.lp_mint.toBase58()
      const stakedAmountRaw = toBigInt(lpPosition.staked_amount)
      if (stakedAmountRaw <= 0n) continue

      const lpDecimals = tokenDecimals(lpMint, tokens, mintDecimalsMap)
      const lpPriceUsd = tokenPriceUsd(lpMint, tokens)
      const stakedValue = buildPositionValue(
        lpMint,
        stakedAmountRaw,
        lpDecimals,
        lpPriceUsd,
      )
      const stakedValueUsd = toScaledDecimal(
        toBigInt(lpPosition.staked_value_usd),
        PRICE_DECIMALS,
      )

      const position: StakingDefiPosition = {
        platformId: 'gmtrade',
        positionKind: 'staking',
        staked: [stakedValue],
        ...(stakedValueUsd !== '0' && { usdValue: stakedValueUsd }),
        meta: {
          gmtrade: {
            lpMint,
            controller: lpPosition.controller.toBase58(),
            positionAccount: lpPositionAddress,
            positionId: toBigInt(lpPosition.position_id).toString(),
            stakeStartTime: toBigInt(lpPosition.stake_start_time).toString(),
          },
        },
      }

      result.push(position)
    }

    for (const [marketTokenMint, balanceRaw] of walletMarketTokenBalances) {
      const market = marketByTokenMint.get(marketTokenMint)
      if (!market) continue

      const supplyRaw = mintSupplyMap.get(marketTokenMint) ?? 0n
      const longAmountRaw = mulDivFloor(
        market.primaryPoolLongAmountRaw,
        balanceRaw,
        supplyRaw,
      )
      const shortAmountRaw = mulDivFloor(
        market.primaryPoolShortAmountRaw,
        balanceRaw,
        supplyRaw,
      )

      const perTokenAmount = new Map<string, bigint>()
      if (longAmountRaw > 0n) {
        perTokenAmount.set(market.longTokenMint, longAmountRaw)
      }
      if (shortAmountRaw > 0n) {
        const existing = perTokenAmount.get(market.shortTokenMint) ?? 0n
        perTokenAmount.set(market.shortTokenMint, existing + shortAmountRaw)
      }

      const poolTokens = [...perTokenAmount.entries()].map(
        ([mint, amountRaw]) =>
          buildPositionValue(
            mint,
            amountRaw,
            tokenDecimals(mint, tokens, mintDecimalsMap),
            tokenPriceUsd(mint, tokens),
          ),
      )

      const poolUsdValue = poolTokens
        .map((token) => Number(token.usdValue))
        .filter((value) => Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0)

      const liquidityPosition: ConstantProductLiquidityDefiPosition = {
        platformId: 'gmtrade',
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        poolAddress: market.marketAddress,
        poolTokens:
          poolTokens.length > 0
            ? poolTokens
            : [
                buildPositionValue(
                  marketTokenMint,
                  balanceRaw,
                  tokenDecimals(marketTokenMint, tokens, mintDecimalsMap),
                  tokenPriceUsd(marketTokenMint, tokens),
                ),
              ],
        lpTokenAmount: balanceRaw.toString(),
        ...(poolUsdValue > 0 && { usdValue: poolUsdValue.toString() }),
        meta: {
          gmtrade: {
            store: market.store,
            marketAddress: market.marketAddress,
            marketToken: market.marketTokenMint,
            indexTokenMint: market.indexTokenMint,
            longTokenMint: market.longTokenMint,
            shortTokenMint: market.shortTokenMint,
          },
        },
      }

      result.push(liquidityPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)
    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: GMTRADE_STORE_PROGRAM_ID,
      discriminator: STORE_POSITION_DISCRIMINATOR,
      ownerOffset: POSITION_OWNER_OFFSET,
    },
    {
      programId: GMTRADE_STORE_PROGRAM_ID,
      discriminator: ORDER_DISCRIMINATOR,
      ownerOffset: ACTION_OWNER_OFFSET,
    },
    {
      programId: GMTRADE_LP_PROGRAM_ID,
      discriminator: LP_POSITION_DISCRIMINATOR,
      ownerOffset: LP_POSITION_OWNER_OFFSET,
    },
  ],
}

export default gmtradeIntegration
