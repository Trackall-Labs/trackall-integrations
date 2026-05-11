import {
  genAccDiscriminator,
  Market,
  type OrderType,
  Wrapper,
} from '@bonasa-tech/manifest-sdk'
import { Connection, PublicKey } from '@solana/web3.js'
import type {
  PositionValue,
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  TradingDefiPosition,
  TradingOrder,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'

const MANIFEST_PROGRAM_ID = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms'
const WRAPPER_PROGRAM_ID = 'wMNFSTkir3HgyZTsB7uqu3i7FA73grFCptPXgrZjksL'
const PRICE_SCALE = 10n ** 18n
const MARKET_DISCRIMINATOR = Buffer.from(
  genAccDiscriminator('manifest::state::market::MarketFixed'),
).toString('base64')

type ManifestOrder = {
  trader: PublicKey
  orderType: OrderType
  isBid?: boolean
  numBaseAtoms?: unknown
  price?: unknown
  sequenceNumber?: unknown
}

type WrapperOrder = {
  orderSequenceNumber: unknown
  numBaseAtoms: unknown
  isBid: boolean
  price: number
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [MANIFEST_PROGRAM_ID, WRAPPER_PROGRAM_ID] as const

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  if (value && typeof value === 'object' && 'toString' in value) {
    return BigInt(value.toString())
  }

  return 0n
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n
  return (numerator + denominator - 1n) / denominator
}

function divideToDecimalString(
  numerator: bigint,
  denominator: bigint,
  digits = 8,
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

function buildUsdValue(
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return undefined

  return ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
}

function buildPositionValue(
  token: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const usdValue = buildUsdValue(amountRaw, decimals, priceUsd)

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

function sumUsdValues(values: Array<string | undefined>): string | undefined {
  const numbers = values
    .filter((value): value is string => value !== undefined)
    .map(Number)

  if (numbers.length === 0) return undefined
  return numbers.reduce((sum, value) => sum + value, 0).toString()
}

function buildLimitPrice(
  priceRaw: bigint,
  baseDecimals: number,
  quoteDecimals: number,
) {
  return priceRaw > 0n
    ? divideToDecimalString(
        priceRaw * 10n ** BigInt(baseDecimals),
        PRICE_SCALE * 10n ** BigInt(quoteDecimals),
      )
    : '0'
}

function readSeatBalances(market: Market, trader: PublicKey) {
  const seat = market
    .claimedSeats()
    .find((claimedSeat) => claimedSeat.publicKey.equals(trader))

  if (!seat) {
    return {
      baseWithdrawableAtoms: 0n,
      quoteWithdrawableAtoms: 0n,
    }
  }

  return {
    baseWithdrawableAtoms: toBigInt(seat.baseBalance),
    quoteWithdrawableAtoms: toBigInt(seat.quoteBalance),
  }
}

function buildMarketOrderLookup(market: Market) {
  const lookup = new Map<string, ManifestOrder>()

  for (const order of [...market.bids(), ...market.asks()]) {
    const manifestOrder = order as ManifestOrder
    lookup.set(toBigInt(manifestOrder.sequenceNumber).toString(), manifestOrder)
  }

  return lookup
}

function buildOrderUsdValue(order: TradingOrder): string | undefined {
  return order.selling.usdValue
}

function compareDecimalStrings(a: string, b: string): number {
  return Number.parseFloat(a) - Number.parseFloat(b)
}

function sortTradingOrders(orders: TradingOrder[], side: TradingOrder['side']) {
  orders.sort((left, right) => {
    const leftPrice = left.limitPrice ?? '0'
    const rightPrice = right.limitPrice ?? '0'
    const comparison = compareDecimalStrings(leftPrice, rightPrice)

    if (comparison !== 0) {
      return side === 'buy' ? comparison * -1 : comparison
    }

    return compareDecimalStrings(
      left.selling.amount.amount,
      right.selling.amount.amount,
    )
  })
}

export const manifestIntegration: SolanaIntegration = {
  platformId: 'manifest',

  getUserPositions: async function* (
    address: string,
    { endpoint, tokens }: SolanaPlugins,
  ): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = tokens.get(token)
        if (tokenData === undefined) return undefined
        if (tokenData.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    const trader = new PublicKey(address)
    const currentSlot = await new Connection(endpoint, 'confirmed').getSlot(
      'confirmed',
    )

    const accounts = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: MANIFEST_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: MARKET_DISCRIMINATOR,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: WRAPPER_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 8,
              bytes: address,
              encoding: 'base58',
            },
          },
        ],
      },
    ]

    const allAccounts = Object.values(accounts).filter(
      (account): account is SolanaAccount => account.exists,
    )
    const markets = allAccounts
      .filter((account) => account.programAddress === MANIFEST_PROGRAM_ID)
      .map((account) =>
        Market.loadFromBuffer({
          address: new PublicKey(account.address),
          buffer: Buffer.from(account.data),
          slot: currentSlot,
        }),
      )

    const wrapperAccount = allAccounts.find(
      (account) => account.programAddress === WRAPPER_PROGRAM_ID,
    )
    const wrapper = wrapperAccount
      ? Wrapper.loadFromBuffer({
          address: new PublicKey(wrapperAccount.address),
          buffer: Buffer.from(wrapperAccount.data),
        })
      : null

    const marketByAddress = new Map(
      markets.map((market) => [market.address.toBase58(), market] as const),
    )

    const positions: UserDefiPosition[] = []

    for (const [marketAddress, market] of marketByAddress) {
      const { baseWithdrawableAtoms, quoteWithdrawableAtoms } =
        readSeatBalances(market, trader)
      const baseMint = market.baseMint().toBase58()
      const quoteMint = market.quoteMint().toBase58()
      const baseDecimals = market.baseDecimals()
      const quoteDecimals = market.quoteDecimals()
      const baseToken = tokens.get(baseMint)
      const quoteToken = tokens.get(quoteMint)

      const deposited: PositionValue[] = []
      if (baseWithdrawableAtoms > 0n) {
        deposited.push(
          buildPositionValue(
            baseMint,
            baseWithdrawableAtoms,
            baseDecimals,
            baseToken?.priceUsd,
          ),
        )
      }
      if (quoteWithdrawableAtoms > 0n) {
        deposited.push(
          buildPositionValue(
            quoteMint,
            quoteWithdrawableAtoms,
            quoteDecimals,
            quoteToken?.priceUsd,
          ),
        )
      }

      const buyOrders: TradingOrder[] = []
      const sellOrders: TradingOrder[] = []
      const orders = wrapper?.openOrdersForMarket(market.address) as
        | WrapperOrder[]
        | null
      if (orders && orders.length > 0) {
        const orderLookup = buildMarketOrderLookup(market)

        for (const order of orders) {
          const orderSequenceNumber = toBigInt(
            order.orderSequenceNumber,
          ).toString()
          const marketOrder = orderLookup.get(orderSequenceNumber)
          const numBaseAtoms = toBigInt(
            marketOrder?.numBaseAtoms ?? order.numBaseAtoms,
          )
          const priceRaw =
            marketOrder?.price !== undefined
              ? toBigInt(marketOrder.price)
              : BigInt(Math.ceil(Number(numBaseAtoms) * order.price)) *
                PRICE_SCALE
          const quoteAtoms =
            marketOrder?.price !== undefined
              ? ceilDiv(numBaseAtoms * priceRaw, PRICE_SCALE)
              : BigInt(Math.ceil(Number(numBaseAtoms) * order.price))

          const isBid = marketOrder?.isBid ?? order.isBid
          const sellingMint = isBid ? quoteMint : baseMint
          const buyingMint = isBid ? baseMint : quoteMint
          const sellingDecimals = isBid ? quoteDecimals : baseDecimals
          const buyingDecimals = isBid ? baseDecimals : quoteDecimals
          const sellingToken = isBid ? quoteToken : baseToken
          const buyingToken = isBid ? baseToken : quoteToken
          const sellingAtoms = isBid ? quoteAtoms : numBaseAtoms
          const buyingAtoms = isBid ? numBaseAtoms : quoteAtoms
          const selling = buildPositionValue(
            sellingMint,
            sellingAtoms,
            sellingDecimals,
            sellingToken?.priceUsd,
          )
          const buying = buildPositionValue(
            buyingMint,
            buyingAtoms,
            buyingDecimals,
            buyingToken?.priceUsd,
          )
          const limitPrice = buildLimitPrice(
            priceRaw,
            baseDecimals,
            quoteDecimals,
          )

          const tradingOrder: TradingOrder = {
            side: isBid ? 'buy' : 'sell',
            selling,
            buying,
            limitPrice,
            status: 'open',
          }

          if (isBid) {
            buyOrders.push(tradingOrder)
          } else {
            sellOrders.push(tradingOrder)
          }
        }
      }

      if (
        deposited.length === 0 &&
        buyOrders.length === 0 &&
        sellOrders.length === 0
      ) {
        continue
      }

      sortTradingOrders(buyOrders, 'buy')
      sortTradingOrders(sellOrders, 'sell')

      const position: TradingDefiPosition = {
        platformId: 'manifest',
        positionKind: 'trading',
        marketType: 'spot',
        marginEnabled: false,
        ...(deposited.length > 0 && { deposited }),
        ...(buyOrders.length > 0 && { buyOrders }),
        ...(sellOrders.length > 0 && { sellOrders }),
        ...(() => {
          const usdValue = sumUsdValues([
            ...deposited.map((asset) => asset.usdValue),
            ...buyOrders.map(buildOrderUsdValue),
            ...sellOrders.map(buildOrderUsdValue),
          ])
          return usdValue ? { usdValue } : {}
        })(),
        meta: {
          market: {
            address: marketAddress,
            bestBidPrice: market.bestBidPrice() ?? null,
            bestAskPrice: market.bestAskPrice() ?? null,
          },
        },
      }

      positions.push(position)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: WRAPPER_PROGRAM_ID,
      ownerOffset: 8,
    },
  ],
}

export default manifestIntegration
