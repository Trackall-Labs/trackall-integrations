const KAMINO_API_BASE_URL = 'https://api.kamino.finance'

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseDecimalString(value: string):
  | {
      negative: boolean
      digits: string
      scale: number
    }
  | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined

  const match = trimmed.match(
    /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/,
  )
  if (!match) return undefined

  const negative = match[1] === '-'
  const integerPart = match[2] ?? ''
  const fractionPart = match[3] ?? match[4] ?? ''
  const exponent = Number(match[5] ?? '0')
  if (!Number.isInteger(exponent)) return undefined

  const digits = `${integerPart}${fractionPart}`.replace(/^0+/, '')
  if (digits.length === 0) {
    return { negative: false, digits: '0', scale: 0 }
  }

  return {
    negative,
    digits,
    scale: fractionPart.length - exponent,
  }
}

function formatDecimalString(
  digits: string,
  scale: number,
  negative: boolean,
): string {
  if (digits === '0') return '0'

  let result: string
  if (scale <= 0) {
    result = digits + '0'.repeat(-scale)
  } else if (scale >= digits.length) {
    result = `0.${'0'.repeat(scale - digits.length)}${digits}`
  } else {
    const splitIndex = digits.length - scale
    result = `${digits.slice(0, splitIndex)}.${digits.slice(splitIndex)}`
  }

  if (result.includes('.')) {
    result = result.replace(/\.?0+$/, '')
  }

  return negative ? `-${result}` : result
}

export function normalizeKaminoApyToPercentage(
  value: unknown,
): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return normalizeKaminoApyToPercentage(value.toString())
  }

  if (typeof value !== 'string') return undefined

  const parsed = parseDecimalString(value)
  if (!parsed) return undefined

  return formatDecimalString(parsed.digits, parsed.scale - 2, parsed.negative)
}

export function getKaminoVaultMetricsUrl(vaultAddress: string): string {
  return `${KAMINO_API_BASE_URL}/kvaults/vaults/${vaultAddress}/metrics`
}

export function getKaminoMarketReservesMetricsUrl(
  marketAddress: string,
): string {
  return `${KAMINO_API_BASE_URL}/kamino-market/${marketAddress}/reserves/metrics`
}

export interface KaminoReserveMetrics {
  supplyApyPct?: string
  borrowApyPct?: string
  maxLtv?: string
}

export function parseKaminoMarketReserveMetrics(
  rows: unknown[],
): Map<string, KaminoReserveMetrics> {
  const metricsByReserve = new Map<string, KaminoReserveMetrics>()

  for (const row of rows) {
    const record = toRecord(row)
    if (!record) continue

    const reserveAddress = toNonEmptyString(record.reserve)
    if (!reserveAddress) continue

    const supplyApyPct = normalizeKaminoApyToPercentage(record.supplyApy)
    const borrowApyPct = normalizeKaminoApyToPercentage(record.borrowApy)
    const maxLtv = toNonEmptyString(record.maxLtv)

    if (
      supplyApyPct === undefined &&
      borrowApyPct === undefined &&
      maxLtv === undefined
    ) {
      continue
    }

    metricsByReserve.set(reserveAddress, {
      ...(supplyApyPct !== undefined && { supplyApyPct }),
      ...(borrowApyPct !== undefined && { borrowApyPct }),
      ...(maxLtv !== undefined && { maxLtv }),
    })
  }

  return metricsByReserve
}

export function parseKaminoVaultApyMap(
  rowsByUrl: Map<string, unknown[]>,
  vaultAddresses: Iterable<string>,
): Map<string, string> {
  const apyByVaultAddress = new Map<string, string>()

  for (const vaultAddress of vaultAddresses) {
    const row = rowsByUrl.get(getKaminoVaultMetricsUrl(vaultAddress))?.[0]
    const metrics = toRecord(row)
    if (!metrics) continue

    const apy =
      normalizeKaminoApyToPercentage(metrics.apy) ??
      normalizeKaminoApyToPercentage(metrics.apyActual)
    if (apy === undefined) continue

    apyByVaultAddress.set(vaultAddress, apy)
  }

  return apyByVaultAddress
}

export function parseKaminoStrategyApyMap(
  rows: unknown[],
): Map<string, string> {
  const apyByStrategy = new Map<string, string>()

  for (const row of rows) {
    const record = toRecord(row)
    if (!record) continue

    const strategyAddress = toNonEmptyString(record.strategy)
    if (!strategyAddress) continue

    const apyRecord = toRecord(record.apy)
    const kaminoApyRecord = toRecord(record.kaminoApy)
    const apy =
      normalizeKaminoApyToPercentage(toRecord(kaminoApyRecord?.vault)?.apy7d) ??
      normalizeKaminoApyToPercentage(kaminoApyRecord?.totalApy) ??
      normalizeKaminoApyToPercentage(apyRecord?.totalApy)
    if (apy === undefined) continue

    apyByStrategy.set(strategyAddress, apy)
  }

  return apyByStrategy
}
