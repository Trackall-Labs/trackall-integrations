import { PublicKey } from '@solana/web3.js'
import type {
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  TradingDefiPosition,
  TradingOrder,
  TradingPositionStatus,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const TITAN_LIMIT_ORDERS_PROGRAM_ID =
  'TitanLozLMhczcwrioEguG2aAmiATAPXdYpBg3DbeKK'
const LIMIT_ORDER_ACCOUNT_SIZE = 168
const PRICE_DIGITS = 8

const MAKER_OFFSET = 0
const INPUT_MINT_OFFSET = 32
const OUTPUT_MINT_OFFSET = 64
const CREATION_SLOT_OFFSET = 96
const EXPIRATION_SLOT_OFFSET = 104
const AMOUNT_OFFSET = 112
const AMOUNT_FILLED_OFFSET = 120
const OUT_AMOUNT_FILLED_OFFSET = 128
const OUT_AMOUNT_WITHDRAWN_OFFSET = 136
const FEES_PAID_OFFSET = 144
const PRICE_BASE_OFFSET = 152
const PRICE_EXPONENT_OFFSET = 160
const STATUS_OFFSET = 161
const BUMP_OFFSET = 162
const ID_OFFSET = 163
const INPUT_MINT_VAULT_BUMP_OFFSET = 164
const OUTPUT_MINT_VAULT_BUMP_OFFSET = 165
const TIME_IN_FORCE_OFFSET = 166
const FEE_TICKS_OFFSET = 167
const SPL_MINT_DECIMALS_OFFSET = 44

const ORDER_STATUS_OPEN = 0
const ORDER_STATUS_PARTIALLY_FILLED = 1
const ORDER_STATUS_FILLED = 2

type TitanLimitOrder = {
  address: string
  maker: string
  inputMint: string
  outputMint: string
  creationSlot: bigint
  expirationSlot: bigint
  amount: bigint
  amountFilled: bigint
  outAmountFilled: bigint
  outAmountWithdrawn: bigint
  feesPaid: bigint
  priceBase: bigint
  priceExponent: number
  status: number
  bump: number
  id: number
  inputMintVaultBump: number
  outputMintVaultBump: number
  timeInForce: number
  feeTicks: number
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [TITAN_LIMIT_ORDERS_PROGRAM_ID] as const

function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58()
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset)
}

function readU8(data: Buffer, offset: number): number {
  return data.readUInt8(offset)
}

function parseOrder(address: string, data: Uint8Array): TitanLimitOrder | null {
  const buffer = Buffer.from(data)
  if (buffer.length !== LIMIT_ORDER_ACCOUNT_SIZE) return null

  return {
    address,
    maker: readPubkey(buffer, MAKER_OFFSET),
    inputMint: readPubkey(buffer, INPUT_MINT_OFFSET),
    outputMint: readPubkey(buffer, OUTPUT_MINT_OFFSET),
    creationSlot: readU64(buffer, CREATION_SLOT_OFFSET),
    expirationSlot: readU64(buffer, EXPIRATION_SLOT_OFFSET),
    amount: readU64(buffer, AMOUNT_OFFSET),
    amountFilled: readU64(buffer, AMOUNT_FILLED_OFFSET),
    outAmountFilled: readU64(buffer, OUT_AMOUNT_FILLED_OFFSET),
    outAmountWithdrawn: readU64(buffer, OUT_AMOUNT_WITHDRAWN_OFFSET),
    feesPaid: readU64(buffer, FEES_PAID_OFFSET),
    priceBase: readU64(buffer, PRICE_BASE_OFFSET),
    priceExponent: readU8(buffer, PRICE_EXPONENT_OFFSET),
    status: readU8(buffer, STATUS_OFFSET),
    bump: readU8(buffer, BUMP_OFFSET),
    id: readU8(buffer, ID_OFFSET),
    inputMintVaultBump: readU8(buffer, INPUT_MINT_VAULT_BUMP_OFFSET),
    outputMintVaultBump: readU8(buffer, OUTPUT_MINT_VAULT_BUMP_OFFSET),
    timeInForce: readU8(buffer, TIME_IN_FORCE_OFFSET),
    feeTicks: readU8(buffer, FEE_TICKS_OFFSET),
  }
}

function toTradingStatus(value: number): TradingPositionStatus {
  if (value === ORDER_STATUS_OPEN) return 'open'
  if (value === ORDER_STATUS_PARTIALLY_FILLED) return 'partially-filled'
  if (value === ORDER_STATUS_FILLED) return 'filled'
  return 'cancelled'
}

function isOpenOrderStatus(value: number): boolean {
  return value === ORDER_STATUS_OPEN || value === ORDER_STATUS_PARTIALLY_FILLED
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n
  return (numerator + denominator - 1n) / denominator
}

function divideToDecimalString(
  numerator: bigint,
  denominator: bigint,
  digits = PRICE_DIGITS,
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

function readMintDecimals(data: Uint8Array): number | null {
  const buffer = Buffer.from(data)
  if (buffer.length <= SPL_MINT_DECIMALS_OFFSET) return null
  return readU8(buffer, SPL_MINT_DECIMALS_OFFSET)
}

function expectedOutputAmount(
  inputAmount: bigint,
  order: TitanLimitOrder,
): bigint {
  const scale = 10n ** BigInt(order.priceExponent)
  return ceilDiv(inputAmount * order.priceBase, scale)
}

function buildLimitPrice(
  priceBase: bigint,
  priceExponent: number,
  inputDecimals: number,
  outputDecimals: number,
): string {
  const numerator = priceBase * 10n ** BigInt(inputDecimals)
  const denominator = 10n ** BigInt(priceExponent + outputDecimals)
  return divideToDecimalString(numerator, denominator)
}

function toFilledFraction(
  amount: bigint,
  amountFilled: bigint,
): string | undefined {
  if (amount <= 0n || amountFilled <= 0n) return undefined
  if (amountFilled >= amount) return '1'

  return divideToDecimalString(amountFilled, amount, PRICE_DIGITS)
}

export const titanIntegration: SolanaIntegration = {
  platformId: 'titan',

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

    const discoveredAccounts = yield {
      kind: 'getProgramAccounts' as const,
      programId: TITAN_LIMIT_ORDERS_PROGRAM_ID,
      filters: [
        { dataSize: LIMIT_ORDER_ACCOUNT_SIZE },
        {
          memcmp: {
            offset: MAKER_OFFSET,
            bytes: address,
          },
        },
      ],
    }

    const parsedOrders = Object.values(discoveredAccounts)
      .filter(
        (
          account,
        ): account is (typeof discoveredAccounts)[string] & { exists: true } =>
          account.exists,
      )
      .map((account) => parseOrder(account.address, account.data))
      .filter((order): order is TitanLimitOrder => order !== null)
      .filter((order) => order.maker === address)
      .filter((order) => isOpenOrderStatus(order.status))

    const activeOrders = parsedOrders
      .map((order) => ({
        order,
        remainingInput: order.amount - order.amountFilled,
      }))
      .filter((item) => item.remainingInput > 0n)

    if (activeOrders.length === 0) return []

    const mintAddresses = new Set<string>()
    for (const item of activeOrders) {
      mintAddresses.add(item.order.inputMint)
      mintAddresses.add(item.order.outputMint)
    }

    const mintAccounts = yield [...mintAddresses]
    const mintDecimals = new Map<string, number>()
    for (const mintAddress of mintAddresses) {
      const mintAccount = mintAccounts[mintAddress]
      const token = tokens.get(mintAddress)
      const parsed = mintAccount?.exists
        ? readMintDecimals(mintAccount.data)
        : null
      mintDecimals.set(mintAddress, parsed ?? token?.decimals ?? 0)
    }

    const groupedOrders = new Map<
      string,
      {
        inputMint: string
        outputMint: string
        orders: TradingOrder[]
        orderMeta: Array<Record<string, unknown>>
      }
    >()

    for (const { order, remainingInput } of activeOrders) {
      const inputDecimals = mintDecimals.get(order.inputMint) ?? 0
      const outputDecimals = mintDecimals.get(order.outputMint) ?? 0
      const remainingOutput = expectedOutputAmount(remainingInput, order)
      const inputToken = tokens.get(order.inputMint)
      const outputToken = tokens.get(order.outputMint)
      const filledFraction = toFilledFraction(order.amount, order.amountFilled)

      const tradingOrder: TradingOrder = {
        side: 'sell',
        selling: buildPositionValue(
          order.inputMint,
          remainingInput,
          inputDecimals,
          inputToken?.priceUsd,
        ),
        buying: buildPositionValue(
          order.outputMint,
          remainingOutput,
          outputDecimals,
          outputToken?.priceUsd,
        ),
        limitPrice: buildLimitPrice(
          order.priceBase,
          order.priceExponent,
          inputDecimals,
          outputDecimals,
        ),
        status: toTradingStatus(order.status),
        ...(filledFraction && {
          filledFraction,
        }),
      }

      const marketKey = `${order.inputMint}->${order.outputMint}`
      const existing = groupedOrders.get(marketKey)
      const serializedOrderMeta = {
        orderAddress: order.address,
        maker: order.maker,
        id: order.id,
        status: order.status,
        creationSlot: order.creationSlot.toString(),
        expirationSlot: order.expirationSlot.toString(),
        totalInputAmount: order.amount.toString(),
        filledInputAmount: order.amountFilled.toString(),
        filledOutputAmount: order.outAmountFilled.toString(),
        withdrawnOutputAmount: order.outAmountWithdrawn.toString(),
        feesPaid: order.feesPaid.toString(),
        priceBase: order.priceBase.toString(),
        priceExponent: order.priceExponent,
        bump: order.bump,
        inputMintVaultBump: order.inputMintVaultBump,
        outputMintVaultBump: order.outputMintVaultBump,
        timeInForce: order.timeInForce,
        feeTicks: order.feeTicks,
      }

      if (existing) {
        existing.orders.push(tradingOrder)
        existing.orderMeta.push(serializedOrderMeta)
      } else {
        groupedOrders.set(marketKey, {
          inputMint: order.inputMint,
          outputMint: order.outputMint,
          orders: [tradingOrder],
          orderMeta: [serializedOrderMeta],
        })
      }
    }

    const positions: UserDefiPosition[] = []
    for (const [marketKey, marketGroup] of groupedOrders) {
      marketGroup.orders.sort((left, right) => {
        return (
          Number.parseFloat(left.limitPrice ?? '0') -
          Number.parseFloat(right.limitPrice ?? '0')
        )
      })

      const usdValue = marketGroup.orders
        .map((entry) => entry.selling.usdValue)
        .filter((value): value is string => value !== undefined)
        .reduce((sum, value) => sum + Number(value), 0)

      const position: TradingDefiPosition = {
        platformId: 'titan',
        positionKind: 'trading',
        marketType: 'spot',
        marginEnabled: false,
        sellOrders: marketGroup.orders,
        ...(usdValue > 0 && { usdValue: usdValue.toString() }),
        meta: {
          titan: {
            market: marketKey,
            inputMint: marketGroup.inputMint,
            outputMint: marketGroup.outputMint,
            orderCount: marketGroup.orders.length,
            orders: marketGroup.orderMeta,
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
      programId: TITAN_LIMIT_ORDERS_PROGRAM_ID,
      ownerOffset: MAKER_OFFSET,
      dataSize: LIMIT_ORDER_ACCOUNT_SIZE,
    },
  ],
}

export default titanIntegration
