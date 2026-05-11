import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import type { PublicKey } from '@solana/web3.js'
import flashPerpetualsIdl from 'flash-sdk/dist/idl/perpetuals.json'
import flashPoolConfig from 'flash-sdk/dist/PoolConfig.json'

import type {
  PositionValue,
  RewardDefiPosition,
  SolanaIntegration,
  SolanaPlugins,
  StakedAsset,
  StakingDefiPosition,
  TradingDefiPosition,
  TradingExposureSide,
  TradingOrder,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const FLASH_PROGRAM_ID = 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn'
const POSITION_OWNER_OFFSET = 8
const ORDER_OWNER_OFFSET = 8
const FLP_STAKE_OWNER_OFFSET = 8
const TOKEN_STAKE_OWNER_OFFSET = 8
const PRICE_OUTPUT_DECIMALS = 8
const DEFAULT_TOKEN_DECIMALS = 6
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const FAF_MINT = 'FAFxVxnkzZHMCodkWyoccgUNgVScqMw2mhhQBYDFjFAF'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'
export const PROGRAM_IDS = [FLASH_PROGRAM_ID] as const

type BigNumberish = bigint | number | string | { toString(): string }

type DecodedOraclePrice = {
  price: BigNumberish
  exponent: number
}

type DecodedPosition = {
  owner: PublicKey
  market: PublicKey
  entry_price: DecodedOraclePrice
  reference_price: DecodedOraclePrice
  size_amount: BigNumberish
  size_usd: BigNumberish
  locked_amount: BigNumberish
  collateral_usd: BigNumberish
  is_active: boolean
  size_decimals: number
  collateral_decimals: number
}

type DecodedLimitOrder = {
  limit_price: DecodedOraclePrice
  reserve_amount: BigNumberish
  reserve_custody_uid: number
  receive_custody_uid: number
  size_amount: BigNumberish
  stop_loss_price: DecodedOraclePrice
  take_profit_price: DecodedOraclePrice
}

type DecodedOrder = {
  owner: PublicKey
  market: PublicKey
  limit_orders: DecodedLimitOrder[]
  is_active: boolean
  active_orders: number
}

type DecodedStakeStats = {
  pending_activation: BigNumberish
  active_amount: BigNumberish
  pending_deactivation: BigNumberish
  deactivated_amount: BigNumberish
}

type DecodedFlpStake = {
  owner: PublicKey
  pool: PublicKey
  stake_stats: DecodedStakeStats
  unclaimed_rewards: BigNumberish
}

type DecodedWithdrawRequest = {
  withdrawable_amount: BigNumberish
  locked_amount: BigNumberish
  time_remaining: BigNumberish
}

type DecodedTokenStake = {
  owner: PublicKey
  active_stake_amount: BigNumberish
  reward_tokens: BigNumberish
  unclaimed_revenue_amount: BigNumberish
  withdraw_request: DecodedWithdrawRequest[]
}

type FlashPoolConfigFile = {
  pools: FlashPool[]
}

type FlashPool = {
  cluster: string
  isDeprecated: boolean
  poolName: string
  poolAddress: string
  programId: string
  stakedLpTokenMint: string
  stakedLpTokenSymbol: string
  lpDecimals: number
  custodies: FlashCustody[]
  markets: FlashMarket[]
}

type FlashCustody = {
  custodyId: number
  custodyAccount: string
  symbol: string
  mintKey: string
  decimals: number
  isStable?: boolean
}

type FlashMarket = {
  marketAccount: string
  targetCustody: string
  collateralCustody: string
  side: string
  targetMint?: string
  collateralMint?: string
}

type CustodyMeta = {
  poolName: string
  symbol: string
  mint: string
  decimals: number
}

type MarketMeta = {
  poolName: string
  marketAddress: string
  side: TradingExposureSide
  targetMint?: string
  collateralMint?: string
  targetSymbol?: string
  collateralSymbol?: string
}

type PoolMeta = {
  poolName: string
  poolAddress: string
  stakedLpMint: string
  stakedLpSymbol: string
  lpDecimals: number
  rewardMint: string
  rewardSymbol: string
  rewardDecimals: number
}

type Bucket = {
  marketAddress: string
  marketSymbol: string
  poolName: string
  side: TradingExposureSide
  positions: NonNullable<TradingDefiPosition['positions']>
  buyOrders: TradingOrder[]
  sellOrders: TradingOrder[]
  usdValues: number[]
  positionAccounts: string[]
  orderAccounts: string[]
}

const FLASH_IDL = flashPerpetualsIdl as Idl & {
  accounts?: Array<{ name: string; discriminator: number[] }>
}
const flashCoder = new BorshCoder(FLASH_IDL)
const POSITION_DISCRIMINATOR = accountDiscriminator('Position')
const ORDER_DISCRIMINATOR = accountDiscriminator('Order')
const FLP_STAKE_DISCRIMINATOR = accountDiscriminator('FlpStake')
const TOKEN_STAKE_DISCRIMINATOR = accountDiscriminator('TokenStake')
const POSITION_DISCRIMINATOR_B64 = discriminatorBase64(POSITION_DISCRIMINATOR)
const ORDER_DISCRIMINATOR_B64 = discriminatorBase64(ORDER_DISCRIMINATOR)
const FLP_STAKE_DISCRIMINATOR_B64 = discriminatorBase64(FLP_STAKE_DISCRIMINATOR)
const TOKEN_STAKE_DISCRIMINATOR_B64 = discriminatorBase64(
  TOKEN_STAKE_DISCRIMINATOR,
)

const { marketMetaByAddress, custodyMetaByPoolAndUid, poolMetaByAddress } =
  buildStaticMetadata()

function accountDiscriminator(accountName: string): Uint8Array {
  const account = FLASH_IDL.accounts?.find(
    (candidate) => candidate.name === accountName,
  )
  if (!account) {
    throw new Error(`Flash IDL account "${accountName}" is not present`)
  }

  return Uint8Array.from(account.discriminator)
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

function oraclePriceToString(
  price: DecodedOraclePrice | undefined,
): string | undefined {
  if (!price) return undefined

  const raw = toBigInt(price.price)
  if (raw <= 0n) return undefined

  if (price.exponent >= 0) {
    return (raw * 10n ** BigInt(price.exponent)).toString()
  }

  return divideToDecimalString(
    raw,
    10n ** BigInt(Math.abs(price.exponent)),
    PRICE_OUTPUT_DECIMALS,
  )
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

function sumFinite(values: Array<string | undefined>): string | undefined {
  const numbers = values
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  if (numbers.length === 0) return undefined
  return numbers.reduce((sum, value) => sum + value, 0).toString()
}

function decodeAccount<T>(accountName: string, data: Uint8Array): T | null {
  try {
    return flashCoder.accounts.decode(accountName, Buffer.from(data)) as T
  } catch {
    return null
  }
}

function tokenDecimals(
  mint: string | undefined,
  plugins: SolanaPlugins,
  fallbackDecimals: number,
) {
  if (!mint) return fallbackDecimals
  return plugins.tokens.get(mint)?.decimals ?? fallbackDecimals
}

function tokenPriceUsd(mint: string | undefined, plugins: SolanaPlugins) {
  if (!mint) return undefined
  const price = plugins.tokens.get(mint)?.priceUsd
  if (price === undefined) return undefined

  const value = Number(price)
  return Number.isFinite(value) ? value : undefined
}

function orderSideFromMarketSide(
  side: TradingExposureSide,
): TradingOrder['side'] {
  return side === 'short' ? 'sell' : 'buy'
}

function buildOrderTriggers(
  marketSide: TradingExposureSide,
  stopLossPrice?: string,
  takeProfitPrice?: string,
): TradingOrder['triggers'] | undefined {
  const triggers: NonNullable<TradingOrder['triggers']> = []

  if (stopLossPrice) {
    triggers.push({
      price: stopLossPrice,
      condition: marketSide === 'long' ? 'below' : 'above',
    })
  }
  if (takeProfitPrice) {
    triggers.push({
      price: takeProfitPrice,
      condition: marketSide === 'long' ? 'above' : 'below',
    })
  }

  return triggers.length > 0 ? triggers : undefined
}

function getOrCreateBucket(
  buckets: Map<string, Bucket>,
  marketAddress: string,
  marketMeta?: MarketMeta,
): Bucket {
  const existing = buckets.get(marketAddress)
  if (existing) return existing

  const bucket: Bucket = {
    marketAddress,
    marketSymbol: buildMarketSymbol(marketAddress, marketMeta),
    poolName: marketMeta?.poolName ?? 'unknown',
    side: marketMeta?.side ?? 'long',
    positions: [],
    buyOrders: [],
    sellOrders: [],
    usdValues: [],
    positionAccounts: [],
    orderAccounts: [],
  }

  buckets.set(marketAddress, bucket)
  return bucket
}

function buildMarketSymbol(
  marketAddress: string,
  marketMeta?: MarketMeta,
): string {
  if (!marketMeta) return marketAddress
  const target = marketMeta.targetSymbol ?? marketMeta.targetMint
  const collateral = marketMeta.collateralSymbol ?? marketMeta.collateralMint
  if (target && collateral) return `${target}-${collateral}`
  return target ?? collateral ?? marketAddress
}

function buildStaticMetadata() {
  const config = flashPoolConfig as FlashPoolConfigFile
  const pools = (config.pools ?? []).filter(
    (pool) => pool.cluster === 'mainnet-beta' && !pool.isDeprecated,
  )

  const custodyMetaByPoolAndUid = new Map<string, CustodyMeta>()
  const marketMetaByAddress = new Map<string, MarketMeta>()
  const poolMetaByAddress = new Map<string, PoolMeta>()

  for (const pool of pools) {
    const custodyByAddress = new Map<string, CustodyMeta>()
    for (const custody of pool.custodies ?? []) {
      const meta: CustodyMeta = {
        poolName: pool.poolName,
        symbol: custody.symbol,
        mint: custody.mintKey,
        decimals: custody.decimals,
      }

      custodyByAddress.set(custody.custodyAccount, meta)
      custodyMetaByPoolAndUid.set(`${pool.poolName}:${custody.custodyId}`, meta)
    }

    for (const market of pool.markets ?? []) {
      const targetCustodyMeta = custodyByAddress.get(market.targetCustody)
      const collateralCustodyMeta = custodyByAddress.get(
        market.collateralCustody,
      )

      const marketMeta: MarketMeta = {
        poolName: pool.poolName,
        marketAddress: market.marketAccount,
        side: market.side === 'short' ? 'short' : 'long',
      }
      const targetMint = market.targetMint ?? targetCustodyMeta?.mint
      const collateralMint =
        market.collateralMint ?? collateralCustodyMeta?.mint
      if (targetMint) marketMeta.targetMint = targetMint
      if (collateralMint) marketMeta.collateralMint = collateralMint
      if (targetCustodyMeta?.symbol)
        marketMeta.targetSymbol = targetCustodyMeta.symbol
      if (collateralCustodyMeta?.symbol) {
        marketMeta.collateralSymbol = collateralCustodyMeta.symbol
      }

      marketMetaByAddress.set(market.marketAccount, marketMeta)
    }

    const rewardCustody =
      pool.custodies.find((custody) => custody.symbol === 'USDC') ??
      pool.custodies.find((custody) => custody.isStable) ??
      pool.custodies[0]

    if (rewardCustody) {
      poolMetaByAddress.set(pool.poolAddress, {
        poolName: pool.poolName,
        poolAddress: pool.poolAddress,
        stakedLpMint: pool.stakedLpTokenMint,
        stakedLpSymbol: pool.stakedLpTokenSymbol,
        lpDecimals: pool.lpDecimals,
        rewardMint: rewardCustody.mintKey,
        rewardSymbol: rewardCustody.symbol,
        rewardDecimals: rewardCustody.decimals,
      })
    }
  }

  return { marketMetaByAddress, custodyMetaByPoolAndUid, poolMetaByAddress }
}

export const flashtradeIntegration: SolanaIntegration = {
  platformId: 'flashtrade',

  getUserPositions: async function* (
    address: string,
    _plugins: SolanaPlugins,
  ): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = _plugins.tokens.get(token)
        if (tokenData === undefined) return undefined
        if (tokenData.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    const requests = PROGRAM_IDS.flatMap((programId) => [
      {
        kind: 'getProgramAccounts' as const,
        programId,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: POSITION_DISCRIMINATOR_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: POSITION_OWNER_OFFSET,
              bytes: address,
              encoding: 'base58' as const,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: ORDER_DISCRIMINATOR_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: ORDER_OWNER_OFFSET,
              bytes: address,
              encoding: 'base58' as const,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: FLP_STAKE_DISCRIMINATOR_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: FLP_STAKE_OWNER_OFFSET,
              bytes: address,
              encoding: 'base58' as const,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: TOKEN_STAKE_DISCRIMINATOR_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: TOKEN_STAKE_OWNER_OFFSET,
              bytes: address,
              encoding: 'base58' as const,
            },
          },
        ],
      },
    ])

    const accounts = yield requests
    const decodedPositions: Array<{ address: string; data: DecodedPosition }> =
      []
    const decodedOrders: Array<{ address: string; data: DecodedOrder }> = []
    const decodedFlpStakes: Array<{ address: string; data: DecodedFlpStake }> =
      []
    const decodedTokenStakes: Array<{
      address: string
      data: DecodedTokenStake
    }> = []

    for (const account of Object.values(accounts)) {
      if (!account.exists) continue
      if (account.programAddress !== FLASH_PROGRAM_ID) continue

      const position = decodeAccount<DecodedPosition>('Position', account.data)
      if (position) {
        decodedPositions.push({ address: account.address, data: position })
        continue
      }

      const order = decodeAccount<DecodedOrder>('Order', account.data)
      if (order) {
        decodedOrders.push({ address: account.address, data: order })
        continue
      }

      const flpStake = decodeAccount<DecodedFlpStake>('FlpStake', account.data)
      if (flpStake) {
        decodedFlpStakes.push({ address: account.address, data: flpStake })
        continue
      }

      const tokenStake = decodeAccount<DecodedTokenStake>(
        'TokenStake',
        account.data,
      )
      if (tokenStake) {
        decodedTokenStakes.push({ address: account.address, data: tokenStake })
      }
    }

    const buckets = new Map<string, Bucket>()

    for (const {
      address: positionAddress,
      data: position,
    } of decodedPositions) {
      const marketAddress = position.market.toBase58()
      const marketMeta = marketMetaByAddress.get(marketAddress)
      const bucket = getOrCreateBucket(buckets, marketAddress, marketMeta)
      bucket.positionAccounts.push(positionAddress)

      const notionalUsd = toScaledDecimal(
        toBigInt(position.size_usd),
        position.size_decimals,
      )
      const notionalUsdNumber = Number(notionalUsd)
      if (Number.isFinite(notionalUsdNumber)) {
        bucket.usdValues.push(notionalUsdNumber)
      }

      const sizeAmountRaw = toBigInt(position.size_amount)
      const sizeMint = marketMeta?.targetMint
      const sizeDecimals = tokenDecimals(
        sizeMint,
        _plugins,
        position.size_decimals,
      )

      const collateralAmountRaw = toBigInt(position.locked_amount)
      const collateralMint = marketMeta?.collateralMint
      const collateralFallbackDecimals = position.collateral_decimals
      const collateralDecimals = tokenDecimals(
        collateralMint,
        _plugins,
        collateralFallbackDecimals,
      )
      const collateralPrice = tokenPriceUsd(collateralMint, _plugins)
      const entryPrice = oraclePriceToString(position.entry_price)
      const markPrice = oraclePriceToString(position.reference_price)

      const tradingPosition: NonNullable<
        TradingDefiPosition['positions']
      >[number] = {
        side: bucket.side,
        ...(notionalUsd !== '0' && { notionalUsd }),
        ...(sizeAmountRaw > 0n &&
          sizeMint && {
            size: buildPositionValue(sizeMint, sizeAmountRaw, sizeDecimals),
          }),
        ...(collateralAmountRaw > 0n &&
          collateralMint && {
            collateral: [
              buildPositionValue(
                collateralMint,
                collateralAmountRaw,
                collateralDecimals,
                collateralPrice,
              ),
            ],
          }),
        ...(entryPrice && { entryPrice }),
        ...(markPrice && { markPrice }),
      }

      if (position.is_active || notionalUsd !== '0') {
        bucket.positions.push(tradingPosition)
      }
    }

    for (const { address: orderAddress, data: order } of decodedOrders) {
      if (!order.is_active || order.active_orders === 0) continue

      const marketAddress = order.market.toBase58()
      const marketMeta = marketMetaByAddress.get(marketAddress)
      const bucket = getOrCreateBucket(buckets, marketAddress, marketMeta)
      const marketSide = marketMeta?.side ?? bucket.side
      const orderSide = orderSideFromMarketSide(marketSide)
      const targetMint = marketMeta?.targetMint
      const targetDecimals = tokenDecimals(targetMint, _plugins, 6)

      for (const limitOrder of order.limit_orders ?? []) {
        const sizeAmountRaw = toBigInt(limitOrder.size_amount)
        const reserveAmountRaw = toBigInt(limitOrder.reserve_amount)
        if (sizeAmountRaw <= 0n && reserveAmountRaw <= 0n) continue

        const reserveMeta = marketMeta
          ? custodyMetaByPoolAndUid.get(
              `${marketMeta.poolName}:${limitOrder.reserve_custody_uid}`,
            )
          : undefined
        const receiveMeta = marketMeta
          ? custodyMetaByPoolAndUid.get(
              `${marketMeta.poolName}:${limitOrder.receive_custody_uid}`,
            )
          : undefined

        const reserveMint = reserveMeta?.mint ?? marketMeta?.collateralMint
        const receiveMint = receiveMeta?.mint ?? targetMint
        const reserveDecimals = tokenDecimals(
          reserveMint,
          _plugins,
          reserveMeta?.decimals ?? 6,
        )
        const receiveDecimals = tokenDecimals(
          receiveMint,
          _plugins,
          receiveMeta?.decimals ?? targetDecimals,
        )
        const reservePrice = tokenPriceUsd(reserveMint, _plugins)
        const receivePrice = tokenPriceUsd(receiveMint, _plugins)

        const sellingMint = orderSide === 'buy' ? reserveMint : receiveMint
        const buyingMint = orderSide === 'buy' ? receiveMint : reserveMint
        const sellingAmountRaw =
          orderSide === 'buy' ? reserveAmountRaw : sizeAmountRaw
        const buyingAmountRaw =
          orderSide === 'buy' ? sizeAmountRaw : reserveAmountRaw
        if (!sellingMint || !buyingMint) continue
        const limitPrice = oraclePriceToString(limitOrder.limit_price)
        const triggers = buildOrderTriggers(
          marketSide,
          oraclePriceToString(limitOrder.stop_loss_price),
          oraclePriceToString(limitOrder.take_profit_price),
        )

        const orderItem: TradingOrder = {
          side: orderSide,
          selling: buildPositionValue(
            sellingMint,
            sellingAmountRaw,
            orderSide === 'buy' ? reserveDecimals : receiveDecimals,
            orderSide === 'buy' ? reservePrice : receivePrice,
          ),
          buying: buildPositionValue(
            buyingMint,
            buyingAmountRaw,
            orderSide === 'buy' ? receiveDecimals : reserveDecimals,
            orderSide === 'buy' ? receivePrice : reservePrice,
          ),
          ...(limitPrice && { limitPrice }),
          ...(triggers && { triggers }),
          status: 'open',
        }

        if (orderSide === 'buy') {
          bucket.buyOrders.push(orderItem)
        } else {
          bucket.sellOrders.push(orderItem)
        }
        bucket.orderAccounts.push(orderAddress)
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

      const tradingPosition: TradingDefiPosition = {
        platformId: 'flashtrade',
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
          flashtrade: {
            pool: bucket.poolName,
            marketAddress: bucket.marketAddress,
            marketSymbol: bucket.marketSymbol,
            positionAccounts: bucket.positionAccounts,
            orderAccounts: bucket.orderAccounts,
          },
        },
      }

      result.push(tradingPosition)
    }

    for (const { address: stakeAddress, data: flpStake } of decodedFlpStakes) {
      const activeAmount = toBigInt(flpStake.stake_stats.active_amount)
      const unclaimedRewards = toBigInt(flpStake.unclaimed_rewards)
      if (activeAmount <= 0n && unclaimedRewards <= 0n) continue

      const poolAddress = flpStake.pool.toBase58()
      const poolMeta = poolMetaByAddress.get(poolAddress)

      const stakedMint = poolMeta?.stakedLpMint
      const stakedDecimals = tokenDecimals(
        stakedMint,
        _plugins,
        poolMeta?.lpDecimals ?? DEFAULT_TOKEN_DECIMALS,
      )
      const stakedPrice = tokenPriceUsd(stakedMint, _plugins)
      const rewardMint = poolMeta?.rewardMint ?? USDC_MINT
      const rewardDecimals = tokenDecimals(
        rewardMint,
        _plugins,
        poolMeta?.rewardDecimals ?? DEFAULT_TOKEN_DECIMALS,
      )
      const rewardPrice = tokenPriceUsd(rewardMint, _plugins)

      const claimableReward =
        unclaimedRewards > 0n
          ? buildPositionValue(
              rewardMint,
              unclaimedRewards,
              rewardDecimals,
              rewardPrice,
            )
          : undefined

      if (activeAmount > 0n && stakedMint) {
        const staked: StakedAsset[] = [
          {
            ...buildPositionValue(
              stakedMint,
              activeAmount,
              stakedDecimals,
              stakedPrice,
            ),
            ...(claimableReward && { claimableReward }),
          },
        ]

        const usdValue = sumFinite([
          ...staked.map((value) => value.usdValue),
          ...staked
            .map((value) => value.claimableReward?.usdValue)
            .filter((value): value is string => value !== undefined),
        ])

        const stakingPosition: StakingDefiPosition = {
          platformId: 'flashtrade',
          positionKind: 'staking',
          staked,
          ...(usdValue && { usdValue }),
          meta: {
            flashtrade: {
              stakingType: 'flp',
              pool: poolMeta?.poolName ?? poolAddress,
              poolAddress,
              stakedSymbol: poolMeta?.stakedLpSymbol,
              rewardSymbol: poolMeta?.rewardSymbol,
              stakeAccount: stakeAddress,
            },
          },
        }

        result.push(stakingPosition)
      } else if (claimableReward) {
        const rewardPosition: RewardDefiPosition = {
          platformId: 'flashtrade',
          positionKind: 'reward',
          claimable: [claimableReward],
          meta: {
            flashtrade: {
              source: 'flp-stake',
              pool: poolMeta?.poolName ?? poolAddress,
              poolAddress,
              stakeAccount: stakeAddress,
            },
          },
        }

        result.push(rewardPosition)
      }
    }

    for (const {
      address: tokenStakeAddress,
      data: tokenStake,
    } of decodedTokenStakes) {
      const activeStakeAmount = toBigInt(tokenStake.active_stake_amount)
      const rewardTokens = toBigInt(tokenStake.reward_tokens)
      const unclaimedRevenueAmount = toBigInt(
        tokenStake.unclaimed_revenue_amount,
      )
      const withdrawRequests = (tokenStake.withdraw_request ?? []).map(
        (request) => ({
          withdrawableAmount: toBigInt(request.withdrawable_amount),
          lockedAmount: toBigInt(request.locked_amount),
          timeRemaining: Number(toBigInt(request.time_remaining)),
        }),
      )

      const stakedMint = FAF_MINT
      const stakedDecimals = tokenDecimals(
        stakedMint,
        _plugins,
        DEFAULT_TOKEN_DECIMALS,
      )
      const stakedPrice = tokenPriceUsd(stakedMint, _plugins)
      const revenueMint = USDC_MINT
      const revenueDecimals = tokenDecimals(
        revenueMint,
        _plugins,
        DEFAULT_TOKEN_DECIMALS,
      )
      const revenuePrice = tokenPriceUsd(revenueMint, _plugins)

      if (
        activeStakeAmount <= 0n &&
        rewardTokens <= 0n &&
        unclaimedRevenueAmount <= 0n &&
        withdrawRequests.every(
          (request) =>
            request.withdrawableAmount <= 0n && request.lockedAmount <= 0n,
        )
      ) {
        continue
      }

      if (activeStakeAmount > 0n) {
        const claimableReward =
          rewardTokens > 0n
            ? buildPositionValue(
                stakedMint,
                rewardTokens,
                stakedDecimals,
                stakedPrice,
              )
            : undefined
        const stakingUsdValue = sumFinite([claimableReward?.usdValue])

        const stakingPosition: StakingDefiPosition = {
          platformId: 'flashtrade',
          positionKind: 'staking',
          staked: [
            {
              ...buildPositionValue(
                stakedMint,
                activeStakeAmount,
                stakedDecimals,
                stakedPrice,
              ),
              ...(claimableReward && { claimableReward }),
            },
          ],
          ...(stakingUsdValue && { usdValue: stakingUsdValue }),
          meta: {
            flashtrade: {
              stakingType: 'token',
              tokenStakeAccount: tokenStakeAddress,
              token: 'FAF',
            },
          },
        }

        result.push(stakingPosition)
      }

      const claimable = []
      if (rewardTokens > 0n) {
        claimable.push(
          buildPositionValue(
            stakedMint,
            rewardTokens,
            stakedDecimals,
            stakedPrice,
          ),
        )
      }
      if (unclaimedRevenueAmount > 0n) {
        claimable.push(
          buildPositionValue(
            revenueMint,
            unclaimedRevenueAmount,
            revenueDecimals,
            revenuePrice,
          ),
        )
      }
      for (const [index, request] of withdrawRequests.entries()) {
        if (request.withdrawableAmount > 0n) {
          claimable.push(
            buildPositionValue(
              stakedMint,
              request.withdrawableAmount,
              stakedDecimals,
              stakedPrice,
            ),
          )
        }
        if (request.lockedAmount > 0n) {
          if (request.timeRemaining > 0) {
            const unlockAt =
              Math.floor(Date.now() / 1000) + request.timeRemaining
            const rewardPosition: RewardDefiPosition = {
              platformId: 'flashtrade',
              positionKind: 'reward',
              claimable: [
                buildPositionValue(
                  stakedMint,
                  request.lockedAmount,
                  stakedDecimals,
                  stakedPrice,
                ),
              ],
              claimableFrom: new Date(unlockAt * 1000).toISOString(),
              meta: {
                flashtrade: {
                  source: 'token-withdraw-request',
                  tokenStakeAccount: tokenStakeAddress,
                  requestIndex: index,
                },
              },
            }
            result.push(rewardPosition)
          } else {
            claimable.push(
              buildPositionValue(
                stakedMint,
                request.lockedAmount,
                stakedDecimals,
                stakedPrice,
              ),
            )
          }
        }
      }

      if (claimable.length > 0) {
        const rewardPosition: RewardDefiPosition = {
          platformId: 'flashtrade',
          positionKind: 'reward',
          claimable,
          meta: {
            flashtrade: {
              source: 'token-stake',
              tokenStakeAccount: tokenStakeAddress,
            },
          },
        }

        result.push(rewardPosition)
      }
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)
    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: FLASH_PROGRAM_ID,
      discriminator: POSITION_DISCRIMINATOR,
      ownerOffset: POSITION_OWNER_OFFSET,
    },
    {
      programId: FLASH_PROGRAM_ID,
      discriminator: ORDER_DISCRIMINATOR,
      ownerOffset: ORDER_OWNER_OFFSET,
    },
    {
      programId: FLASH_PROGRAM_ID,
      discriminator: FLP_STAKE_DISCRIMINATOR,
      ownerOffset: FLP_STAKE_OWNER_OFFSET,
    },
    {
      programId: FLASH_PROGRAM_ID,
      discriminator: TOKEN_STAKE_DISCRIMINATOR,
      ownerOffset: TOKEN_STAKE_OWNER_OFFSET,
    },
  ],
}

export default flashtradeIntegration
