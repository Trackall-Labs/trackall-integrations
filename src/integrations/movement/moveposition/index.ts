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

const MOVEPOSITION_API_URL = 'https://api.moveposition.xyz' as const

export const testAddress =
  '0xdd284fb30311654251f1bc7ee9293962e1f28177534a56185ad5a553a72ed911'

interface MovePositionInstrument {
  networkAddress: string
  name: string
  decimals: number
  price?: number
}

interface MovePositionPortfolioLeg {
  instrument: MovePositionInstrument
  amount: string
}

interface MovePositionPortfolioResponse {
  collaterals?: MovePositionPortfolioLeg[]
  liabilities?: MovePositionPortfolioLeg[]
  evaluation?: {
    health_ratio?: number
    total_collateral?: number
    total_liability?: number
  }
}

interface MovePositionBrokerResponse {
  utilization: number
  interestRate: number
  interestFeeRate: number
  underlyingAsset: MovePositionInstrument
  loanNote: MovePositionInstrument & {
    price?: number
  }
  depositNote: MovePositionInstrument & {
    price?: number
  }
  loanNoteExchangeRate: number
  depositNoteExchangeRate: number
}

function decimalStringToFraction(value: string): {
  numerator: bigint
  denominator: bigint
} {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error('Cannot parse empty decimal value')
  }

  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [integerPart, fractionalPart = ''] = unsigned.split('.')

  if (!/^\d+$/.test(integerPart || '0') || !/^\d*$/.test(fractionalPart)) {
    throw new Error(`Invalid decimal value "${value}"`)
  }

  const denominator = 10n ** BigInt(fractionalPart.length)
  const numerator = BigInt(`${integerPart || '0'}${fractionalPart || ''}`)

  return {
    numerator: negative ? -numerator : numerator,
    denominator,
  }
}

function multiplyRawAmount(rawAmount: string, exchangeRate: number): string {
  const { numerator, denominator } = decimalStringToFraction(
    exchangeRate.toString(),
  )
  const amount = BigInt(rawAmount)
  const scaled = amount * numerator
  const rounded =
    scaled >= 0n
      ? (scaled + denominator / 2n) / denominator
      : (scaled - denominator / 2n) / denominator

  return rounded.toString()
}

function buildUsdValue(
  rawAmount: string,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  return ((Number(rawAmount) / 10 ** decimals) * priceUsd).toString()
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const response = await fetch(`${MOVEPOSITION_API_URL}${path}`, init)

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(
      `MovePosition API request failed: ${response.status} ${path}`,
    )
  }

  return (await response.json()) as T
}

function buildSuppliedAsset(
  leg: MovePositionPortfolioLeg,
  broker: MovePositionBrokerResponse,
): LendingSuppliedAsset {
  const underlyingAmount = multiplyRawAmount(
    leg.amount,
    broker.depositNoteExchangeRate,
  )
  const priceUsd = broker.underlyingAsset.price
  const usdValue = buildUsdValue(
    underlyingAmount,
    broker.underlyingAsset.decimals,
    priceUsd,
  )

  return {
    amount: {
      token: broker.underlyingAsset.networkAddress,
      amount: underlyingAmount,
      decimals: broker.underlyingAsset.decimals.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
    supplyRate: (
      broker.utilization *
      broker.interestRate *
      (1 - broker.interestFeeRate)
    ).toString(),
  }
}

function buildBorrowedAsset(
  leg: MovePositionPortfolioLeg,
  broker: MovePositionBrokerResponse,
): LendingBorrowedAsset {
  const underlyingAmount = multiplyRawAmount(
    leg.amount,
    broker.loanNoteExchangeRate,
  )
  const priceUsd = broker.underlyingAsset.price
  const usdValue = buildUsdValue(
    underlyingAmount,
    broker.underlyingAsset.decimals,
    priceUsd,
  )

  return {
    amount: {
      token: broker.underlyingAsset.networkAddress,
      amount: underlyingAmount,
      decimals: broker.underlyingAsset.decimals.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

async function getUserPositions(
  address: string,
  plugins: AptosPlugins,
): Promise<UserDefiPosition[]> {
  void plugins

  const [portfolio, brokers] = await Promise.all([
    fetchJson<MovePositionPortfolioResponse>(`/portfolios/${address}`),
    fetchJson<MovePositionBrokerResponse[]>('/brokers'),
  ])

  if (!portfolio) return []
  if (!brokers) {
    throw new Error('MovePosition brokers endpoint returned no data')
  }

  const collaterals = portfolio.collaterals ?? []
  const liabilities = portfolio.liabilities ?? []
  if (collaterals.length === 0 && liabilities.length === 0) return []

  const brokerByDepositNote = new Map(
    brokers.map((broker) => [broker.depositNote.name, broker] as const),
  )
  const brokerByLoanNote = new Map(
    brokers.map((broker) => [broker.loanNote.name, broker] as const),
  )

  const supplied = collaterals.map((leg) => {
    const broker = brokerByDepositNote.get(leg.instrument.name)
    if (!broker) {
      throw new Error(
        `MovePosition broker metadata missing for collateral instrument "${leg.instrument.name}"`,
      )
    }

    return buildSuppliedAsset(leg, broker)
  })

  const borrowed = liabilities.map((leg) => {
    const broker = brokerByLoanNote.get(leg.instrument.name)
    if (!broker) {
      throw new Error(
        `MovePosition broker metadata missing for liability instrument "${leg.instrument.name}"`,
      )
    }

    return buildBorrowedAsset(leg, broker)
  })

  const evaluation = portfolio.evaluation
  const usdValue =
    evaluation?.total_collateral !== undefined &&
    evaluation?.total_liability !== undefined
      ? (evaluation.total_collateral - evaluation.total_liability).toString()
      : undefined

  const position: LendingDefiPosition = {
    positionKind: 'lending',
    platformId: 'moveposition',
    ...(supplied.length > 0 && { supplied }),
    ...(borrowed.length > 0 && { borrowed }),
    ...(usdValue !== undefined && { usdValue }),
    ...(evaluation?.health_ratio !== undefined && {
      healthFactor: evaluation.health_ratio.toString(),
    }),
  }

  return [position]
}

export const movepositionIntegration: AptosIntegration = {
  platformId: 'moveposition',
  getUserPositions,
}

export default movepositionIntegration
