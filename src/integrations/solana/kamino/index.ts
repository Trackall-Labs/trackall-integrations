import { BN } from '@coral-xyz/anchor'
import { FarmState, UserState } from '@kamino-finance/farms-sdk'
import { Obligation, Reserve, VaultState } from '@kamino-finance/klend-sdk'
import { WhirlpoolStrategy } from '@kamino-finance/kliquidity-sdk/dist/@codegen/kliquidity/accounts'
import {
  BinArray as MeteoraBinArray,
  PositionV2 as MeteoraPositionV2,
} from '@kamino-finance/kliquidity-sdk/dist/@codegen/meteora/accounts'
import { PROGRAM_ID as METEORA_PROGRAM_ID } from '@kamino-finance/kliquidity-sdk/dist/@codegen/meteora/programId'
import {
  PersonalPositionState as RaydiumPersonalPositionState,
  PoolState as RaydiumPoolState,
} from '@kamino-finance/kliquidity-sdk/dist/@codegen/raydium/accounts'
import { PROGRAM_ID as RAYDIUM_PROGRAM_ID } from '@kamino-finance/kliquidity-sdk/dist/@codegen/raydium/programId'
import {
  binIdToBinArrayIndex,
  getBinFromBinArrays,
} from '@kamino-finance/kliquidity-sdk/dist/utils/meteora'
import type {
  PositionData as OrcaPositionData,
  WhirlpoolData as OrcaWhirlpoolData,
} from '@orca-so/whirlpools-sdk'
import {
  PoolUtil as OrcaPoolUtil,
  PriceMath as OrcaPriceMath,
  ParsablePosition as ParsableOrcaPosition,
  ParsableWhirlpool as ParsableOrcaWhirlpool,
} from '@orca-so/whirlpools-sdk'
import {
  LiquidityMath as RaydiumLiquidityMath,
  SqrtPriceMath as RaydiumSqrtPriceMath,
} from '@raydium-io/raydium-sdk-v2/lib'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  MaybeSolanaAccount,
  ProgramRequest,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'
import {
  getKaminoMarketReservesMetricsUrl,
  getKaminoVaultMetricsUrl,
  type KaminoReserveMetrics,
  parseKaminoMarketReserveMetrics,
  parseKaminoStrategyApyMap,
  parseKaminoVaultApyMap,
} from './apy'

export const testAddress = '93PSyNrS7zBhrXaHHfU1ZtfegcKq5SaCYc35ZwPVrK3K'

const KLEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'
const KVAULT_PROGRAM_ID = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd'
const FARMS_PROGRAM_ID = 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr'
const KLIQUIDITY_PROGRAM_ID = '6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc'
const ONE_HOUR_IN_MS = 60 * 60 * 1000
export const PROGRAM_IDS = [
  KLEND_PROGRAM_ID,
  KVAULT_PROGRAM_ID,
  FARMS_PROGRAM_ID,
  KLIQUIDITY_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

const DEFAULT_PUBKEY = '11111111111111111111111111111111'
const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const KVAULT_SHARES_MINT_OFFSET = 184
const SF_DENOMINATOR = 1n << 60n
const FARMS_WAD = 10n ** 18n
const ORCA_DEX = 0
const RAYDIUM_DEX = 1
const METEORA_DEX = 2
const KAMINO_API_BASE_URL = 'https://api.kamino.finance'
const KAMINO_KVAULTS_LIST_URL = `${KAMINO_API_BASE_URL}/kvaults/vaults`
const KAMINO_STRATEGIES_METRICS_URL = `${KAMINO_API_BASE_URL}/strategies/metrics?env=mainnet-beta&status=LIVE`
const KAMINO_APY_CACHE_TTL_MS = 60 * 60 * 1000

interface KlendDeposit {
  depositReserve: string
  depositedAmount: bigint
  marketValueSf: bigint
}

interface KlendBorrow {
  borrowReserve: string
  borrowedAmountSf: bigint
  marketValueSf: bigint
}

interface KlendObligationDecoded {
  owner: string
  lendingMarket: string
  deposits: KlendDeposit[]
  borrows: KlendBorrow[]
  isStale: boolean
  depositedValueSf: bigint
  borrowedAssetsMarketValueSf: bigint
  allowedBorrowValueSf: bigint
  borrowFactorAdjustedDebtValueSf: bigint
}

interface KlendReserveDecoded {
  liquidityMint: string
  liquidityDecimals: number
  collateralMint: string
  liquidityAvailableAmount: bigint
  liquidityBorrowedAmountSf: bigint
  accumulatedProtocolFeesSf: bigint
  accumulatedReferrerFeesSf: bigint
  pendingReferrerFeesSf: bigint
  collateralMintTotalSupply: bigint
}

interface FarmsUserStateAggregate {
  activeStakeScaled: bigint
  pendingWithdrawalUnstakeScaled: bigint
  rewardsIssuedUnclaimed: bigint[]
}

interface PublicKeyLike {
  toString(): string
}

interface KlendObligationWire {
  owner: PublicKeyLike
  lendingMarket: PublicKeyLike
  lastUpdate: {
    stale: unknown
  }
  deposits: Array<{
    depositReserve: string
    depositedAmount: unknown
    marketValueSf: unknown
  }>
  borrows: Array<{
    borrowReserve: string
    borrowedAmountSf: unknown
    marketValueSf: unknown
  }>
  depositedValueSf: unknown
  borrowedAssetsMarketValueSf: unknown
  allowedBorrowValueSf: unknown
  borrowFactorAdjustedDebtValueSf: unknown
}

interface KlendReserveWire {
  liquidity: {
    mintPubkey: string
    mintDecimals: unknown
    availableAmount: unknown
    borrowedAmountSf: unknown
    accumulatedProtocolFeesSf: unknown
    accumulatedReferrerFeesSf: unknown
    pendingReferrerFeesSf: unknown
  }
  collateral: {
    mintPubkey: string
    mintTotalSupply: unknown
  }
}

interface KVaultStateWire {
  tokenMint: string
  tokenMintDecimals: unknown
  sharesIssued: unknown
  sharesMint: string
  sharesMintDecimals: unknown
  prevAumSf: unknown
  pendingFeesSf: unknown
}

interface FarmsUserStateWire {
  farmState: PublicKeyLike
  activeStakeScaled: unknown
  pendingWithdrawalUnstakeScaled: unknown
  rewardsIssuedUnclaimed: unknown[]
}

interface FarmStateWire {
  token: {
    mint: PublicKeyLike
    decimals: unknown
  }
  strategyId: PublicKeyLike
  vaultId: PublicKeyLike
  rewardInfos: Array<{
    token: {
      mint: PublicKeyLike
      decimals: unknown
    }
  }>
}

interface KVaultDecoded {
  tokenMint: string
  tokenDecimals: number
  sharesMint: string
  sharesDecimals: number
  sharesIssued: bigint
  netAumRaw: bigint
}

interface UnderlyingAmountFromShares {
  tokenMint: string
  tokenDecimals: number
  amountRaw: bigint
}

interface KliquidityStrategyDecoded {
  sharesMint: string
  sharesDecimals: number
  sharesIssued: bigint
  tokenAMint: string
  tokenBMint: string
  tokenADecimals: number
  tokenBDecimals: number
  availableTokenAAmountRaw: bigint
  availableTokenBAmountRaw: bigint
  strategyDex: number
  pool: string
  position: string
}

interface StrategyUnderlyingFromShares {
  tokenA: UnderlyingAmountFromShares
  tokenB: UnderlyingAmountFromShares
}

interface StrategyInvestedTokenAmountsRaw {
  tokenAAmountRaw: bigint
  tokenBAmountRaw: bigint
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function decodeHttpJsonRow(
  account: MaybeSolanaAccount | undefined,
): unknown | undefined {
  if (!account?.exists || account.programAddress !== 'http-json') {
    return undefined
  }

  try {
    return JSON.parse(Buffer.from(account.data).toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

function groupHttpJsonRowsByUrl(
  accountsMap: Record<string, MaybeSolanaAccount>,
): Map<string, unknown[]> {
  const grouped = new Map<string, Array<{ index: number; row: unknown }>>()

  for (const account of Object.values(accountsMap)) {
    if (!account.exists || account.programAddress !== 'http-json') continue

    const delimiterIndex = account.address.lastIndexOf('#')
    if (delimiterIndex <= 0 || delimiterIndex >= account.address.length - 1) {
      continue
    }

    const url = account.address.slice(0, delimiterIndex)
    const indexString = account.address.slice(delimiterIndex + 1)
    const index = Number(indexString)
    if (!Number.isInteger(index) || index < 0) continue

    const row = decodeHttpJsonRow(account)
    if (row === undefined) continue

    const entries = grouped.get(url) ?? []
    entries.push({ index, row })
    grouped.set(url, entries)
  }

  const rowsByUrl = new Map<string, unknown[]>()
  for (const [url, entries] of grouped.entries()) {
    entries.sort((left, right) => left.index - right.index)
    rowsByUrl.set(
      url,
      entries.map((entry) => entry.row),
    )
  }

  return rowsByUrl
}

function parseKaminoVaultCatalog(rows: unknown[]): {
  farmToVault: Map<string, string>
  vaultAddresses: Set<string>
} {
  const farmToVault = new Map<string, string>()
  const vaultAddresses = new Set<string>()

  for (const row of rows) {
    const record = toRecord(row)
    if (!record) continue

    const vaultAddress = toNonEmptyString(record.address)
    if (!vaultAddress) continue
    vaultAddresses.add(vaultAddress)

    const state = toRecord(record.state)
    const vaultFarm = toNonEmptyString(state?.vaultFarm)
    if (!vaultFarm || vaultFarm === DEFAULT_PUBKEY) continue

    farmToVault.set(vaultFarm, vaultAddress)
  }

  return { farmToVault, vaultAddresses }
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (value && typeof value === 'object' && 'toString' in value) {
    return BigInt(String(value))
  }
  return 0n
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (value && typeof value === 'object' && 'toString' in value) {
    return Number(String(value))
  }
  return 0
}

function deriveMeteoraBinArrayAddress(
  poolAddress: string,
  index: BN,
): PublicKey {
  const binArrayBytes = index.isNeg()
    ? index.toTwos(64).toBuffer('le', 8)
    : index.toBuffer('le', 8)
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('bin_array'),
      new PublicKey(poolAddress).toBuffer(),
      Buffer.from(binArrayBytes),
    ],
    new PublicKey(String(METEORA_PROGRAM_ID)),
  )
  return pda
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset)
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function readTokenAccountMint(data: Uint8Array): string | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_MINT_OFFSET + 32) return null
  return readPubkey(buf, TOKEN_ACCOUNT_MINT_OFFSET)
}

function readTokenAccountAmount(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return null
  return readU64LE(buf, TOKEN_ACCOUNT_AMOUNT_OFFSET)
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

function parseOrcaWhirlpool(
  address: string,
  account: MaybeSolanaAccount | undefined,
): OrcaWhirlpoolData | null {
  return ParsableOrcaWhirlpool.parse(
    new PublicKey(address),
    toAccountInfo(account),
  )
}

function parseOrcaPosition(
  address: string,
  account: MaybeSolanaAccount | undefined,
): OrcaPositionData | null {
  return ParsableOrcaPosition.parse(
    new PublicKey(address),
    toAccountInfo(account),
  )
}

function decodeRaydiumPoolState(
  accountData: Uint8Array,
): RaydiumPoolState | null {
  try {
    return RaydiumPoolState.decode(Buffer.from(accountData))
  } catch {
    return null
  }
}

function decodeRaydiumPersonalPositionState(
  accountData: Uint8Array,
): RaydiumPersonalPositionState | null {
  try {
    return RaydiumPersonalPositionState.decode(Buffer.from(accountData))
  } catch {
    return null
  }
}

function decodeMeteoraPositionV2(
  accountData: Uint8Array,
): MeteoraPositionV2 | null {
  try {
    return MeteoraPositionV2.decode(Buffer.from(accountData))
  } catch {
    return null
  }
}

function decodeMeteoraBinArray(
  accountData: Uint8Array,
): MeteoraBinArray | null {
  try {
    return MeteoraBinArray.decode(Buffer.from(accountData))
  } catch {
    return null
  }
}

function sfToLamports(valueSf: bigint): bigint {
  return valueSf / SF_DENOMINATOR
}

function divideToDecimalString(
  numerator: bigint,
  denominator: bigint,
  digits = 6,
): string {
  if (denominator === 0n) return '0'
  const negative = numerator < 0n !== denominator < 0n
  const absNum = numerator < 0n ? -numerator : numerator
  const absDen = denominator < 0n ? -denominator : denominator

  const integerPart = absNum / absDen
  const remainder = absNum % absDen
  if (digits <= 0 || remainder === 0n) {
    return `${negative ? '-' : ''}${integerPart}`
  }

  const scale = 10n ** BigInt(digits)
  const frac = (remainder * scale) / absDen
  const fracTrimmed = frac.toString().replace(/0+$/, '')
  if (fracTrimmed.length === 0) {
    return `${negative ? '-' : ''}${integerPart}`
  }

  return `${negative ? '-' : ''}${integerPart}.${fracTrimmed}`
}

function sfToDecimalString(valueSf: bigint, digits = 6): string {
  return divideToDecimalString(valueSf, SF_DENOMINATOR, digits)
}

function scaledWadsToRawAmount(value: bigint): bigint {
  return value / FARMS_WAD
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

function sumUsdValues(values: Array<string | undefined>): string | undefined {
  const present = values.filter((value) => value !== undefined)
  if (present.length === 0) return undefined

  const total = present.reduce((sum, value) => sum + Number(value), 0)
  if (!Number.isFinite(total)) return undefined
  return total.toString()
}

function netUsdValueFromCompleteComponents(
  supplied: LendingSuppliedAsset[],
  borrowed: LendingBorrowedAsset[],
): string | undefined {
  const assets = [...supplied, ...borrowed]
  if (
    assets.length === 0 ||
    assets.some((asset) => asset.usdValue === undefined)
  ) {
    return undefined
  }

  const suppliedTotal = supplied.reduce(
    (sum, asset) => sum + Number(asset.usdValue),
    0,
  )
  const borrowedTotal = borrowed.reduce(
    (sum, asset) => sum + Number(asset.usdValue),
    0,
  )
  const total = suppliedTotal - borrowedTotal
  if (!Number.isFinite(total)) return undefined
  return total.toString()
}

export function getKaminoLendingUsdValue(
  amountRaw: bigint,
  decimals: number,
  priceUsd: number | undefined,
  marketValueSf: bigint,
  isObligationStale: boolean,
): string | undefined {
  const pricedValue = buildUsdValue(amountRaw, decimals, priceUsd)
  if (pricedValue !== undefined) return pricedValue
  if (isObligationStale) return undefined
  return sfToDecimalString(marketValueSf)
}

function weightedSupplyApyPct(
  legs: Array<{ usdValue: string | undefined; ratePct: string | undefined }>,
  equityUsd: string | undefined,
): string | undefined {
  if (equityUsd === undefined) return undefined
  const equity = Number(equityUsd)
  if (!Number.isFinite(equity) || equity === 0) return undefined

  let interestPctUsd = 0
  let anyRate = false

  for (const leg of legs) {
    if (leg.usdValue === undefined || leg.ratePct === undefined) continue
    const usd = Number(leg.usdValue)
    const rate = Number(leg.ratePct)
    if (!Number.isFinite(usd) || !Number.isFinite(rate)) continue
    interestPctUsd += usd * rate
    anyRate = true
  }

  if (!anyRate) return undefined

  const apy = interestPctUsd / Math.abs(equity)
  if (!Number.isFinite(apy)) return undefined
  return apy.toString()
}

function decodeKlendObligation(
  accountData: Uint8Array,
): KlendObligationDecoded {
  const decoded = Obligation.decode(
    Buffer.from(accountData),
  ) as KlendObligationWire

  const deposits: KlendDeposit[] = decoded.deposits
    .map((d) => ({
      depositReserve: d.depositReserve,
      depositedAmount: toBigInt(d.depositedAmount),
      marketValueSf: toBigInt(d.marketValueSf),
    }))
    .filter(
      (d) => d.depositReserve !== DEFAULT_PUBKEY && d.depositedAmount > 0n,
    )

  const borrows: KlendBorrow[] = decoded.borrows
    .map((b) => ({
      borrowReserve: b.borrowReserve,
      borrowedAmountSf: toBigInt(b.borrowedAmountSf),
      marketValueSf: toBigInt(b.marketValueSf),
    }))
    .filter(
      (b) => b.borrowReserve !== DEFAULT_PUBKEY && b.borrowedAmountSf > 0n,
    )

  return {
    owner: decoded.owner.toString(),
    lendingMarket: decoded.lendingMarket.toString(),
    deposits,
    borrows,
    isStale: toNumber(decoded.lastUpdate.stale) !== 0,
    depositedValueSf: toBigInt(decoded.depositedValueSf),
    borrowedAssetsMarketValueSf: toBigInt(decoded.borrowedAssetsMarketValueSf),
    allowedBorrowValueSf: toBigInt(decoded.allowedBorrowValueSf),
    borrowFactorAdjustedDebtValueSf: toBigInt(
      decoded.borrowFactorAdjustedDebtValueSf,
    ),
  }
}

function decodeKlendReserve(accountData: Uint8Array): KlendReserveDecoded {
  const decoded = Reserve.decode(Buffer.from(accountData)) as KlendReserveWire

  return {
    liquidityMint: decoded.liquidity.mintPubkey,
    liquidityDecimals: toNumber(decoded.liquidity.mintDecimals),
    collateralMint: decoded.collateral.mintPubkey,
    liquidityAvailableAmount: toBigInt(decoded.liquidity.availableAmount),
    liquidityBorrowedAmountSf: toBigInt(decoded.liquidity.borrowedAmountSf),
    accumulatedProtocolFeesSf: toBigInt(
      decoded.liquidity.accumulatedProtocolFeesSf,
    ),
    accumulatedReferrerFeesSf: toBigInt(
      decoded.liquidity.accumulatedReferrerFeesSf,
    ),
    pendingReferrerFeesSf: toBigInt(decoded.liquidity.pendingReferrerFeesSf),
    collateralMintTotalSupply: toBigInt(decoded.collateral.mintTotalSupply),
  }
}

function decodeKVaultSharesMintAndDecimals(
  accountData: Uint8Array,
): KVaultDecoded | null {
  const decoded = VaultState.decode(Buffer.from(accountData)) as KVaultStateWire
  if (decoded.sharesMint === DEFAULT_PUBKEY) return null

  const netAumSf = toBigInt(decoded.prevAumSf) - toBigInt(decoded.pendingFeesSf)
  return {
    tokenMint: decoded.tokenMint,
    tokenDecimals: toNumber(decoded.tokenMintDecimals),
    sharesMint: decoded.sharesMint,
    sharesDecimals: toNumber(decoded.sharesMintDecimals),
    sharesIssued: toBigInt(decoded.sharesIssued),
    netAumRaw: netAumSf > 0n ? sfToLamports(netAumSf) : 0n,
  }
}

function decodeKliquidityStrategy(
  accountData: Uint8Array,
): KliquidityStrategyDecoded | null {
  const decoded = WhirlpoolStrategy.decode(Buffer.from(accountData))
  if (decoded.sharesMint.toString() === DEFAULT_PUBKEY) return null

  return {
    sharesMint: decoded.sharesMint.toString(),
    sharesDecimals: toNumber(decoded.sharesMintDecimals),
    sharesIssued: toBigInt(decoded.sharesIssued),
    tokenAMint: decoded.tokenAMint.toString(),
    tokenBMint: decoded.tokenBMint.toString(),
    tokenADecimals: toNumber(decoded.tokenAMintDecimals),
    tokenBDecimals: toNumber(decoded.tokenBMintDecimals),
    availableTokenAAmountRaw: toBigInt(decoded.tokenAAmounts),
    availableTokenBAmountRaw: toBigInt(decoded.tokenBAmounts),
    strategyDex: toNumber(decoded.strategyDex),
    pool: decoded.pool.toString(),
    position: decoded.position.toString(),
  }
}

function convertVaultSharesToUnderlyingAmount(
  sharesAmountRaw: bigint,
  vault: KVaultDecoded,
): UnderlyingAmountFromShares | null {
  if (
    sharesAmountRaw <= 0n ||
    vault.sharesIssued <= 0n ||
    vault.netAumRaw <= 0n ||
    vault.tokenMint === DEFAULT_PUBKEY
  ) {
    return null
  }

  const amountRaw = (sharesAmountRaw * vault.netAumRaw) / vault.sharesIssued
  if (amountRaw <= 0n) return null

  return {
    tokenMint: vault.tokenMint,
    tokenDecimals: vault.tokenDecimals,
    amountRaw,
  }
}

function convertStrategySharesToUnderlyingAmounts(
  sharesAmountRaw: bigint,
  strategy: KliquidityStrategyDecoded,
  invested?: StrategyInvestedTokenAmountsRaw,
): StrategyUnderlyingFromShares | null {
  if (
    sharesAmountRaw <= 0n ||
    strategy.sharesIssued <= 0n ||
    strategy.tokenAMint === DEFAULT_PUBKEY ||
    strategy.tokenBMint === DEFAULT_PUBKEY
  ) {
    return null
  }

  const totalTokenAAmountRaw =
    strategy.availableTokenAAmountRaw + (invested?.tokenAAmountRaw ?? 0n)
  const totalTokenBAmountRaw =
    strategy.availableTokenBAmountRaw + (invested?.tokenBAmountRaw ?? 0n)
  if (totalTokenAAmountRaw <= 0n && totalTokenBAmountRaw <= 0n) return null

  const tokenAAmountRaw =
    (sharesAmountRaw * totalTokenAAmountRaw) / strategy.sharesIssued
  const tokenBAmountRaw =
    (sharesAmountRaw * totalTokenBAmountRaw) / strategy.sharesIssued
  if (tokenAAmountRaw <= 0n && tokenBAmountRaw <= 0n) return null

  return {
    tokenA: {
      tokenMint: strategy.tokenAMint,
      tokenDecimals: strategy.tokenADecimals,
      amountRaw: tokenAAmountRaw,
    },
    tokenB: {
      tokenMint: strategy.tokenBMint,
      tokenDecimals: strategy.tokenBDecimals,
      amountRaw: tokenBAmountRaw,
    },
  }
}

function getOrcaInvestedStrategyTokenAmounts(
  whirlpool: OrcaWhirlpoolData,
  position: OrcaPositionData,
): StrategyInvestedTokenAmountsRaw | null {
  try {
    const quote = OrcaPoolUtil.getTokenAmountsFromLiquidity(
      position.liquidity,
      whirlpool.sqrtPrice,
      OrcaPriceMath.tickIndexToSqrtPriceX64(position.tickLowerIndex),
      OrcaPriceMath.tickIndexToSqrtPriceX64(position.tickUpperIndex),
      false,
    )
    return {
      tokenAAmountRaw: BigInt(quote.tokenA.toString()),
      tokenBAmountRaw: BigInt(quote.tokenB.toString()),
    }
  } catch {
    return null
  }
}

function getRaydiumInvestedStrategyTokenAmounts(
  pool: RaydiumPoolState,
  position: RaydiumPersonalPositionState,
): StrategyInvestedTokenAmountsRaw | null {
  try {
    const lowerSqrtPriceX64 = RaydiumSqrtPriceMath.getSqrtPriceX64FromTick(
      position.tickLowerIndex,
    )
    const upperSqrtPriceX64 = RaydiumSqrtPriceMath.getSqrtPriceX64FromTick(
      position.tickUpperIndex,
    )

    const quote = RaydiumLiquidityMath.getAmountsFromLiquidity(
      pool.sqrtPriceX64,
      new BN(lowerSqrtPriceX64),
      new BN(upperSqrtPriceX64),
      position.liquidity,
      false,
    )

    return {
      tokenAAmountRaw: BigInt(quote.amountA.toString()),
      tokenBAmountRaw: BigInt(quote.amountB.toString()),
    }
  } catch {
    return null
  }
}

function getMeteoraInvestedStrategyTokenAmounts(
  position: MeteoraPositionV2,
  binArrays: MeteoraBinArray[],
): StrategyInvestedTokenAmountsRaw | null {
  let totalTokenAAmountRaw = 0n
  let totalTokenBAmountRaw = 0n

  for (let binId = position.lowerBinId; binId <= position.upperBinId; binId++) {
    const bin = getBinFromBinArrays(binId, binArrays)
    if (!bin) continue

    const binTokenAAmountRaw = toBigInt(bin.amountX)
    const binTokenBAmountRaw = toBigInt(bin.amountY)
    const binLiquidityRaw = toBigInt(bin.liquiditySupply)
    if (binLiquidityRaw <= 0n) continue

    const positionLiquidityShareRaw =
      position.liquidityShares[binId - position.lowerBinId]
    const positionLiquidityRaw = toBigInt(positionLiquidityShareRaw)
    if (positionLiquidityRaw <= 0n) continue

    totalTokenAAmountRaw +=
      (binTokenAAmountRaw * positionLiquidityRaw) / binLiquidityRaw
    totalTokenBAmountRaw +=
      (binTokenBAmountRaw * positionLiquidityRaw) / binLiquidityRaw
  }

  if (totalTokenAAmountRaw <= 0n && totalTokenBAmountRaw <= 0n) return null
  return {
    tokenAAmountRaw: totalTokenAAmountRaw,
    tokenBAmountRaw: totalTokenBAmountRaw,
  }
}

function collateralToUnderlyingAmount(
  depositedCollateralAmount: bigint,
  reserve: KlendReserveDecoded,
): bigint {
  const totalSupplyLamports =
    reserve.liquidityAvailableAmount +
    sfToLamports(reserve.liquidityBorrowedAmountSf) -
    sfToLamports(reserve.accumulatedProtocolFeesSf) -
    sfToLamports(reserve.accumulatedReferrerFeesSf) -
    sfToLamports(reserve.pendingReferrerFeesSf)

  if (reserve.collateralMintTotalSupply <= 0n || totalSupplyLamports <= 0n) {
    return depositedCollateralAmount
  }

  const converted =
    (depositedCollateralAmount * totalSupplyLamports) /
    reserve.collateralMintTotalSupply
  return converted > 0n ? converted : depositedCollateralAmount
}

const OBLIGATION_DISC_B64 = Buffer.from(Obligation.discriminator).toString(
  'base64',
)
const RESERVE_DISC_B64 = Buffer.from(Reserve.discriminator).toString('base64')
const KVAULT_STATE_DISC_B64 = Buffer.from(VaultState.discriminator).toString(
  'base64',
)
const FARMS_USER_STATE_DISC_B64 = Buffer.from(UserState.discriminator).toString(
  'base64',
)

export const kaminoIntegration: SolanaIntegration = {
  platformId: 'kamino',

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

    const userTokenAccounts = yield [
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

    const userMintBalances = new Map<string, bigint>()
    for (const account of Object.values(userTokenAccounts)) {
      if (!account.exists) continue
      const mint = readTokenAccountMint(account.data)
      const amount = readTokenAccountAmount(account.data)
      if (!mint || amount === null || amount <= 0n) continue

      userMintBalances.set(mint, (userMintBalances.get(mint) ?? 0n) + amount)
    }

    const kvaultRequests = [...userMintBalances.keys()].map((mint) => ({
      kind: 'getProgramAccounts' as const,
      cacheTtlMs: ONE_HOUR_IN_MS,
      programId: KVAULT_PROGRAM_ID,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: KVAULT_STATE_DISC_B64,
            encoding: 'base64' as const,
          },
        },
        {
          memcmp: {
            offset: KVAULT_SHARES_MINT_OFFSET,
            bytes: mint,
          },
        },
      ],
    }))

    const phase1Requests = [
      {
        kind: 'getProgramAccounts' as const,
        programId: KLEND_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: OBLIGATION_DISC_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: 64,
              bytes: address,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: KLEND_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: RESERVE_DISC_B64,
              encoding: 'base64' as const,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: FARMS_PROGRAM_ID,
        filters: [
          {
            dataSize: UserState.layout.span + 8,
          },
          {
            memcmp: {
              offset: 0,
              bytes: FARMS_USER_STATE_DISC_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: 48,
              bytes: address,
            },
          },
        ],
      },
      ...kvaultRequests,
    ]
    const phase1Map = yield phase1Requests

    const obligations: KlendObligationDecoded[] = []
    const reserveAddressSet = new Set<string>()
    const reserveByAddress = new Map<string, KlendReserveDecoded>()
    const obligationDepositReserveSet = new Set<string>()
    const lendingMarketSet = new Set<string>()
    const farmAddressSet = new Set<string>()
    const farmStrategyAddressSet = new Set<string>()
    const farmsUserStates = new Map<string, FarmsUserStateAggregate>()
    const kvaultByAddress = new Map<string, KVaultDecoded>()
    const strategyByAddress = new Map<string, KliquidityStrategyDecoded>()
    const strategyInvestedByAddress = new Map<
      string,
      StrategyInvestedTokenAmountsRaw
    >()

    const kvaultSharePositions: UserDefiPosition[] = []
    const kvaultVaultAddressByPosition = new Map<UserDefiPosition, string>()
    const farmsPositionsWithAddress: Array<{
      position: UserDefiPosition
      farmAddress: string
      farmVaultAddress: string
      farmStrategyAddress: string
    }> = []
    const seenSharesMints = new Set<string>()

    for (const account of Object.values(phase1Map)) {
      if (!account.exists) continue

      if (account.programAddress === KLEND_PROGRAM_ID) {
        try {
          const obligation = decodeKlendObligation(account.data)
          if (obligation.owner !== address) continue
          if (
            obligation.deposits.length === 0 &&
            obligation.borrows.length === 0
          ) {
            continue
          }

          obligations.push(obligation)
          if (obligation.lendingMarket !== DEFAULT_PUBKEY) {
            lendingMarketSet.add(obligation.lendingMarket)
          }
          for (const d of obligation.deposits) {
            reserveAddressSet.add(d.depositReserve)
            obligationDepositReserveSet.add(d.depositReserve)
          }
          for (const b of obligation.borrows) {
            reserveAddressSet.add(b.borrowReserve)
          }
        } catch {
          // Ignore decode failures from unexpected account variants.
        }

        try {
          const reserve = decodeKlendReserve(account.data)
          reserveByAddress.set(account.address, reserve)
        } catch {
          // Ignore non-reserve KLend accounts.
        }
      }

      if (account.programAddress === KVAULT_PROGRAM_ID) {
        try {
          const vault = decodeKVaultSharesMintAndDecimals(account.data)
          if (vault) kvaultByAddress.set(account.address, vault)
          if (!vault || seenSharesMints.has(vault.sharesMint)) continue

          const userShares = userMintBalances.get(vault.sharesMint)
          if (!userShares || userShares <= 0n) continue

          const converted = convertVaultSharesToUnderlyingAmount(
            userShares,
            vault,
          )
          const stakedTokenMint = converted?.tokenMint ?? vault.sharesMint
          const stakedTokenDecimals =
            converted?.tokenDecimals ?? vault.sharesDecimals
          const stakedAmountRaw = converted?.amountRaw ?? userShares
          const token = tokens.get(stakedTokenMint)
          const stakedUsdValue = buildUsdValue(
            stakedAmountRaw,
            stakedTokenDecimals,
            token?.priceUsd,
          )

          seenSharesMints.add(vault.sharesMint)
          const kvaultPosition: UserDefiPosition = {
            platformId: 'kamino',
            positionKind: 'staking',
            ...(stakedUsdValue !== undefined && { usdValue: stakedUsdValue }),
            staked: [
              {
                amount: {
                  token: stakedTokenMint,
                  amount: stakedAmountRaw.toString(),
                  decimals: stakedTokenDecimals.toString(),
                },
                ...(token?.priceUsd !== undefined && {
                  priceUsd: token.priceUsd.toString(),
                }),
                ...(stakedUsdValue !== undefined && {
                  usdValue: stakedUsdValue,
                }),
              },
            ],
            ...(converted && {
              meta: {
                kamino: {
                  source: 'kvault',
                  vault: account.address,
                  shareMint: vault.sharesMint,
                  shareAmountRaw: userShares.toString(),
                  valuationSource: 'vaultSnapshot',
                },
              },
            }),
          }
          kvaultSharePositions.push(kvaultPosition)
          kvaultVaultAddressByPosition.set(kvaultPosition, account.address)
        } catch {
          // Ignore decode failures from non-vault or incompatible accounts.
        }
      }

      if (account.programAddress === FARMS_PROGRAM_ID) {
        try {
          const userState = UserState.decode(
            Buffer.from(account.data),
          ) as FarmsUserStateWire
          const farmAddress = userState.farmState.toString()
          if (farmAddress === DEFAULT_PUBKEY) continue

          farmAddressSet.add(farmAddress)
          const aggregate = farmsUserStates.get(farmAddress) ?? {
            activeStakeScaled: 0n,
            pendingWithdrawalUnstakeScaled: 0n,
            rewardsIssuedUnclaimed: [],
          }
          aggregate.activeStakeScaled += toBigInt(userState.activeStakeScaled)
          aggregate.pendingWithdrawalUnstakeScaled += toBigInt(
            userState.pendingWithdrawalUnstakeScaled,
          )
          for (const [
            index,
            reward,
          ] of userState.rewardsIssuedUnclaimed.entries()) {
            const previous = aggregate.rewardsIssuedUnclaimed[index] ?? 0n
            aggregate.rewardsIssuedUnclaimed[index] =
              previous + toBigInt(reward)
          }
          farmsUserStates.set(farmAddress, aggregate)
        } catch {
          // Ignore decode failures from incompatible farms accounts.
        }
      }
    }

    const reserveAddresses = [...reserveAddressSet]
    const farmAddresses = [...farmAddressSet]
    const batchAddresses = [...reserveAddresses, ...farmAddresses]
    const fetchedAccountsMap =
      batchAddresses.length > 0 ? yield batchAddresses : {}

    for (const reserveAddress of reserveAddresses) {
      if (reserveByAddress.has(reserveAddress)) continue
      const account = fetchedAccountsMap[reserveAddress]
      if (!account?.exists) continue

      try {
        reserveByAddress.set(reserveAddress, decodeKlendReserve(account.data))
      } catch {
        // Skip reserves that fail to decode.
      }
    }

    const farmsByAddress = new Map<string, FarmStateWire>()
    const farmVaultAddressSet = new Set<string>()
    for (const farmAddress of farmAddresses) {
      const account = fetchedAccountsMap[farmAddress]
      if (!account?.exists) continue

      try {
        const farm = FarmState.decode(
          Buffer.from(account.data),
        ) as FarmStateWire
        farmsByAddress.set(farmAddress, farm)

        const strategyAddress = farm.strategyId.toString()
        if (strategyAddress !== DEFAULT_PUBKEY) {
          farmStrategyAddressSet.add(strategyAddress)
        }

        const vaultAddress = farm.vaultId.toString()
        if (vaultAddress !== DEFAULT_PUBKEY) {
          farmVaultAddressSet.add(vaultAddress)
        }
      } catch {
        // Skip farms that fail to decode.
      }
    }

    const farmVaultAddressesToFetch = [...farmVaultAddressSet].filter(
      (vaultAddress) => !kvaultByAddress.has(vaultAddress),
    )
    const farmVaultAccountsMap =
      farmVaultAddressesToFetch.length > 0
        ? yield farmVaultAddressesToFetch
        : {}

    for (const vaultAddress of farmVaultAddressesToFetch) {
      const account = farmVaultAccountsMap[vaultAddress]
      if (!account?.exists) continue

      try {
        const decoded = decodeKVaultSharesMintAndDecimals(account.data)
        if (!decoded) continue
        kvaultByAddress.set(vaultAddress, decoded)
      } catch {
        // Skip KVault accounts that fail to decode.
      }
    }

    const farmStrategyAddresses = [...farmStrategyAddressSet]
    const farmStrategyAccountsMap =
      farmStrategyAddresses.length > 0 ? yield farmStrategyAddresses : {}

    for (const strategyAddress of farmStrategyAddresses) {
      const account = farmStrategyAccountsMap[strategyAddress]
      if (!account?.exists) continue
      if (account.programAddress !== KLIQUIDITY_PROGRAM_ID) continue

      try {
        const decoded = decodeKliquidityStrategy(account.data)
        if (!decoded) continue
        strategyByAddress.set(strategyAddress, decoded)
      } catch {
        // Skip strategy accounts that fail to decode.
      }
    }

    const strategyPoolAndPositionFetchTargets = [
      ...strategyByAddress.entries(),
    ].filter(
      ([, strategy]) =>
        strategy.position !== DEFAULT_PUBKEY &&
        strategy.pool !== DEFAULT_PUBKEY,
    )
    const strategyPoolAndPositionAddresses = [
      ...new Set(
        strategyPoolAndPositionFetchTargets.flatMap(([, strategy]) => [
          strategy.pool,
          strategy.position,
        ]),
      ),
    ]
    const strategyPoolAndPositionAccounts =
      strategyPoolAndPositionAddresses.length > 0
        ? yield strategyPoolAndPositionAddresses
        : {}

    const meteoraPositionsByStrategy = new Map<string, MeteoraPositionV2>()

    for (const [
      strategyAddress,
      strategy,
    ] of strategyPoolAndPositionFetchTargets) {
      if (strategy.strategyDex === ORCA_DEX) {
        const whirlpool = parseOrcaWhirlpool(
          strategy.pool,
          strategyPoolAndPositionAccounts[strategy.pool],
        )
        const position = parseOrcaPosition(
          strategy.position,
          strategyPoolAndPositionAccounts[strategy.position],
        )
        if (!whirlpool || !position) continue

        const invested = getOrcaInvestedStrategyTokenAmounts(
          whirlpool,
          position,
        )
        if (!invested) continue
        strategyInvestedByAddress.set(strategyAddress, invested)
        continue
      }

      if (strategy.strategyDex === RAYDIUM_DEX) {
        const poolAccount = strategyPoolAndPositionAccounts[strategy.pool]
        const positionAccount =
          strategyPoolAndPositionAccounts[strategy.position]
        if (!poolAccount?.exists || !positionAccount?.exists) continue
        if (
          poolAccount.programAddress !== String(RAYDIUM_PROGRAM_ID) ||
          positionAccount.programAddress !== String(RAYDIUM_PROGRAM_ID)
        ) {
          continue
        }

        const pool = decodeRaydiumPoolState(poolAccount.data)
        const position = decodeRaydiumPersonalPositionState(
          positionAccount.data,
        )
        if (!pool || !position) continue

        const invested = getRaydiumInvestedStrategyTokenAmounts(pool, position)
        if (!invested) continue
        strategyInvestedByAddress.set(strategyAddress, invested)
        continue
      }

      if (strategy.strategyDex === METEORA_DEX) {
        const positionAccount =
          strategyPoolAndPositionAccounts[strategy.position]
        if (!positionAccount?.exists) continue
        if (positionAccount.programAddress !== String(METEORA_PROGRAM_ID)) {
          continue
        }

        const position = decodeMeteoraPositionV2(positionAccount.data)
        if (!position) continue
        meteoraPositionsByStrategy.set(strategyAddress, position)
      }
    }

    const meteoraBinArrayAddressesByStrategy = new Map<
      string,
      [string, string]
    >()
    const meteoraBinArrayAddresses = new Set<string>()

    for (const [
      strategyAddress,
      position,
    ] of meteoraPositionsByStrategy.entries()) {
      const strategy = strategyByAddress.get(strategyAddress)
      if (!strategy) continue

      const lowerBinArrayIndex = binIdToBinArrayIndex(
        new BN(position.lowerBinId),
      )
      const lowerBinArrayAddress = deriveMeteoraBinArrayAddress(
        strategy.pool,
        lowerBinArrayIndex,
      )
      const upperBinArrayAddress = deriveMeteoraBinArrayAddress(
        strategy.pool,
        lowerBinArrayIndex.add(new BN(1)),
      )

      const lower = String(lowerBinArrayAddress)
      const upper = String(upperBinArrayAddress)
      meteoraBinArrayAddressesByStrategy.set(strategyAddress, [lower, upper])
      meteoraBinArrayAddresses.add(lower)
      meteoraBinArrayAddresses.add(upper)
    }

    const meteoraBinArrayAccountsMap =
      meteoraBinArrayAddresses.size > 0
        ? yield [...meteoraBinArrayAddresses]
        : {}
    const meteoraBinArrayByAddress = new Map<string, MeteoraBinArray>()

    for (const address of meteoraBinArrayAddresses) {
      const account = meteoraBinArrayAccountsMap[address]
      if (!account?.exists) continue
      if (account.programAddress !== String(METEORA_PROGRAM_ID)) continue

      const decoded = decodeMeteoraBinArray(account.data)
      if (!decoded) continue
      meteoraBinArrayByAddress.set(address, decoded)
    }

    for (const [
      strategyAddress,
      position,
    ] of meteoraPositionsByStrategy.entries()) {
      const binArrayAddresses =
        meteoraBinArrayAddressesByStrategy.get(strategyAddress)
      if (!binArrayAddresses) continue

      const lowerBinArray = meteoraBinArrayByAddress.get(binArrayAddresses[0])
      const upperBinArray = meteoraBinArrayByAddress.get(binArrayAddresses[1])
      if (!lowerBinArray || !upperBinArray) continue

      const invested = getMeteoraInvestedStrategyTokenAmounts(position, [
        lowerBinArray,
        upperBinArray,
      ])
      if (!invested) continue
      strategyInvestedByAddress.set(strategyAddress, invested)
    }

    const lendingPositions: UserDefiPosition[] = []
    const farmsPositions: UserDefiPosition[] = []
    const collateralOnlySupplied: LendingSuppliedAsset[] = []

    const lendingMarketAddresses = [...lendingMarketSet]
    const reserveMetricsRequests: ProgramRequest[] = lendingMarketAddresses.map(
      (marketAddress) => ({
        kind: 'getHttpJson' as const,
        url: getKaminoMarketReservesMetricsUrl(marketAddress),
        cacheTtlMs: KAMINO_APY_CACHE_TTL_MS,
      }),
    )
    const reserveMetricsMap =
      reserveMetricsRequests.length > 0 ? yield reserveMetricsRequests : {}
    const reserveMetricsRowsByUrl = groupHttpJsonRowsByUrl(reserveMetricsMap)
    const reserveMetricsByAddress = new Map<string, KaminoReserveMetrics>()
    for (const marketAddress of lendingMarketAddresses) {
      const rows =
        reserveMetricsRowsByUrl.get(
          getKaminoMarketReservesMetricsUrl(marketAddress),
        ) ?? []
      for (const [reserveAddress, metrics] of parseKaminoMarketReserveMetrics(
        rows,
      ).entries()) {
        reserveMetricsByAddress.set(reserveAddress, metrics)
      }
    }

    for (const obligation of obligations) {
      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []

      for (const deposit of obligation.deposits) {
        const reserve = reserveByAddress.get(deposit.depositReserve)
        if (!reserve || reserve.liquidityMint === DEFAULT_PUBKEY) continue

        const amountRaw = collateralToUnderlyingAmount(
          deposit.depositedAmount,
          reserve,
        )
        const token = tokens.get(reserve.liquidityMint)
        const metrics = reserveMetricsByAddress.get(deposit.depositReserve)
        const usdValue = getKaminoLendingUsdValue(
          amountRaw,
          reserve.liquidityDecimals,
          token?.priceUsd,
          deposit.marketValueSf,
          obligation.isStale,
        )

        supplied.push({
          amount: {
            token: reserve.liquidityMint,
            amount: amountRaw.toString(),
            decimals: reserve.liquidityDecimals.toString(),
          },
          ...(usdValue !== undefined && { usdValue }),
          ...(token?.priceUsd !== undefined && {
            priceUsd: token.priceUsd.toString(),
          }),
          ...(metrics?.supplyApyPct !== undefined && {
            supplyRate: metrics.supplyApyPct,
          }),
          ...(metrics?.maxLtv !== undefined && {
            collateralFactor: metrics.maxLtv,
          }),
        })
      }

      for (const debt of obligation.borrows) {
        const reserve = reserveByAddress.get(debt.borrowReserve)
        if (!reserve || reserve.liquidityMint === DEFAULT_PUBKEY) continue

        const amountRaw = sfToLamports(debt.borrowedAmountSf)
        const token = tokens.get(reserve.liquidityMint)
        const metrics = reserveMetricsByAddress.get(debt.borrowReserve)
        const usdValue = getKaminoLendingUsdValue(
          amountRaw,
          reserve.liquidityDecimals,
          token?.priceUsd,
          debt.marketValueSf,
          obligation.isStale,
        )

        borrowed.push({
          amount: {
            token: reserve.liquidityMint,
            amount: amountRaw.toString(),
            decimals: reserve.liquidityDecimals.toString(),
          },
          ...(usdValue !== undefined && { usdValue }),
          ...(token?.priceUsd !== undefined && {
            priceUsd: token.priceUsd.toString(),
          }),
          ...(metrics?.borrowApyPct !== undefined && {
            borrowRate: metrics.borrowApyPct,
          }),
        })
      }

      if (supplied.length === 0 && borrowed.length === 0) continue

      const usdValue = netUsdValueFromCompleteComponents(supplied, borrowed)

      const position: LendingDefiPosition = {
        platformId: 'kamino',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        ...(usdValue !== undefined && { usdValue }),
      }

      if (borrowed.length === 0) {
        const apy = weightedSupplyApyPct(
          supplied.map((leg) => ({
            usdValue: leg.usdValue,
            ratePct: leg.supplyRate,
          })),
          position.usdValue,
        )
        if (apy !== undefined) position.apy = apy
      }

      if (obligation.borrowFactorAdjustedDebtValueSf > 0n) {
        position.healthFactor = divideToDecimalString(
          obligation.allowedBorrowValueSf,
          obligation.borrowFactorAdjustedDebtValueSf,
          6,
        )
      }

      lendingPositions.push(position)
    }

    for (const [reserveAddress, reserve] of reserveByAddress.entries()) {
      if (obligationDepositReserveSet.has(reserveAddress)) continue
      if (
        reserve.collateralMint === DEFAULT_PUBKEY ||
        reserve.liquidityMint === DEFAULT_PUBKEY
      ) {
        continue
      }

      const collateralBalance = userMintBalances.get(reserve.collateralMint)
      if (!collateralBalance || collateralBalance <= 0n) continue

      const amountRaw = collateralToUnderlyingAmount(collateralBalance, reserve)
      const token = tokens.get(reserve.liquidityMint)
      const usdValue = buildUsdValue(
        amountRaw,
        reserve.liquidityDecimals,
        token?.priceUsd,
      )
      const metrics = reserveMetricsByAddress.get(reserveAddress)
      collateralOnlySupplied.push({
        amount: {
          token: reserve.liquidityMint,
          amount: amountRaw.toString(),
          decimals: reserve.liquidityDecimals.toString(),
        },
        ...(usdValue !== undefined && { usdValue }),
        ...(token?.priceUsd !== undefined && {
          priceUsd: token.priceUsd.toString(),
        }),
        ...(metrics?.supplyApyPct !== undefined && {
          supplyRate: metrics.supplyApyPct,
        }),
        ...(metrics?.maxLtv !== undefined && {
          collateralFactor: metrics.maxLtv,
        }),
      })
    }

    if (collateralOnlySupplied.length > 0) {
      const usdValue = sumUsdValues(
        collateralOnlySupplied.map((asset) => asset.usdValue),
      )
      const apy = weightedSupplyApyPct(
        collateralOnlySupplied.map((leg) => ({
          usdValue: leg.usdValue,
          ratePct: leg.supplyRate,
        })),
        usdValue,
      )
      lendingPositions.push({
        platformId: 'kamino',
        positionKind: 'lending',
        supplied: collateralOnlySupplied,
        ...(usdValue !== undefined && { usdValue }),
        ...(apy !== undefined && { apy }),
      })
    }

    for (const [farmAddress, aggregate] of farmsUserStates.entries()) {
      const farm = farmsByAddress.get(farmAddress)
      if (!farm) continue

      const stakedShareAmountRaw = scaledWadsToRawAmount(
        aggregate.activeStakeScaled,
      )
      const pendingWithdrawalShareAmountRaw = scaledWadsToRawAmount(
        aggregate.pendingWithdrawalUnstakeScaled,
      )
      const stakedShareMint = farm.token.mint.toString()
      const stakedShareDecimalsNum = toNumber(farm.token.decimals)

      const farmVaultAddress = farm.vaultId.toString()
      const farmVault =
        farmVaultAddress !== DEFAULT_PUBKEY
          ? kvaultByAddress.get(farmVaultAddress)
          : undefined
      const farmStrategyAddress = farm.strategyId.toString()
      const farmStrategy =
        farmStrategyAddress !== DEFAULT_PUBKEY
          ? strategyByAddress.get(farmStrategyAddress)
          : undefined
      const farmStrategyInvested =
        farmStrategyAddress !== DEFAULT_PUBKEY
          ? strategyInvestedByAddress.get(farmStrategyAddress)
          : undefined

      const stakedVaultUnderlying =
        farmVault?.sharesMint === stakedShareMint
          ? convertVaultSharesToUnderlyingAmount(
              stakedShareAmountRaw,
              farmVault,
            )
          : null
      const pendingVaultUnderlying =
        farmVault?.sharesMint === stakedShareMint
          ? convertVaultSharesToUnderlyingAmount(
              pendingWithdrawalShareAmountRaw,
              farmVault,
            )
          : null

      const stakedStrategyUnderlying =
        farmStrategy?.sharesMint === stakedShareMint
          ? convertStrategySharesToUnderlyingAmounts(
              stakedShareAmountRaw,
              farmStrategy,
              farmStrategyInvested,
            )
          : null
      const pendingStrategyUnderlying =
        farmStrategy?.sharesMint === stakedShareMint
          ? convertStrategySharesToUnderlyingAmounts(
              pendingWithdrawalShareAmountRaw,
              farmStrategy,
              farmStrategyInvested,
            )
          : null

      const stakingComponentUsdValues: Array<string | undefined> = []
      const staked: Array<{
        amount: {
          token: string
          amount: string
          decimals: string
        }
        priceUsd?: string
        usdValue?: string
      }> = []
      const unbonding: Array<{
        amount: {
          token: string
          amount: string
          decimals: string
        }
        priceUsd?: string
        usdValue?: string
      }> = []

      const appendAmountValue = (
        target:
          | Array<{
              amount: {
                token: string
                amount: string
                decimals: string
              }
              priceUsd?: string
              usdValue?: string
            }>
          | undefined,
        tokenMint: string,
        amountRaw: bigint,
        decimals: number,
      ): void => {
        if (!target || amountRaw <= 0n) return
        const tokenInfo = tokens.get(tokenMint)
        const usdValue = buildUsdValue(amountRaw, decimals, tokenInfo?.priceUsd)
        stakingComponentUsdValues.push(usdValue)

        target.push({
          amount: {
            token: tokenMint,
            amount: amountRaw.toString(),
            decimals: decimals.toString(),
          },
          ...(tokenInfo?.priceUsd !== undefined && {
            priceUsd: tokenInfo.priceUsd.toString(),
          }),
          ...(usdValue !== undefined && { usdValue }),
        })
      }

      if (stakedStrategyUnderlying) {
        appendAmountValue(
          staked,
          stakedStrategyUnderlying.tokenA.tokenMint,
          stakedStrategyUnderlying.tokenA.amountRaw,
          stakedStrategyUnderlying.tokenA.tokenDecimals,
        )
        appendAmountValue(
          staked,
          stakedStrategyUnderlying.tokenB.tokenMint,
          stakedStrategyUnderlying.tokenB.amountRaw,
          stakedStrategyUnderlying.tokenB.tokenDecimals,
        )
      } else if (stakedVaultUnderlying) {
        appendAmountValue(
          staked,
          stakedVaultUnderlying.tokenMint,
          stakedVaultUnderlying.amountRaw,
          stakedVaultUnderlying.tokenDecimals,
        )
      } else {
        appendAmountValue(
          staked,
          stakedShareMint,
          stakedShareAmountRaw,
          stakedShareDecimalsNum,
        )
      }

      if (pendingStrategyUnderlying) {
        appendAmountValue(
          unbonding,
          pendingStrategyUnderlying.tokenA.tokenMint,
          pendingStrategyUnderlying.tokenA.amountRaw,
          pendingStrategyUnderlying.tokenA.tokenDecimals,
        )
        appendAmountValue(
          unbonding,
          pendingStrategyUnderlying.tokenB.tokenMint,
          pendingStrategyUnderlying.tokenB.amountRaw,
          pendingStrategyUnderlying.tokenB.tokenDecimals,
        )
      } else if (pendingVaultUnderlying) {
        appendAmountValue(
          unbonding,
          pendingVaultUnderlying.tokenMint,
          pendingVaultUnderlying.amountRaw,
          pendingVaultUnderlying.tokenDecimals,
        )
      } else {
        appendAmountValue(
          unbonding,
          stakedShareMint,
          pendingWithdrawalShareAmountRaw,
          stakedShareDecimalsNum,
        )
      }

      const rewardUsdValues: Array<string | undefined> = []

      const rewards = farm.rewardInfos
        .map((rewardInfo, index) => {
          const claimableAmountRaw =
            aggregate.rewardsIssuedUnclaimed[index] ?? 0n
          if (
            claimableAmountRaw <= 0n ||
            rewardInfo.token.mint.toString() === DEFAULT_PUBKEY
          ) {
            return null
          }
          const rewardMint = rewardInfo.token.mint.toString()
          const rewardDecimals = toNumber(rewardInfo.token.decimals)
          const rewardToken = tokens.get(rewardMint)
          const rewardUsdValue = buildUsdValue(
            claimableAmountRaw,
            rewardDecimals,
            rewardToken?.priceUsd,
          )
          rewardUsdValues.push(rewardUsdValue)

          return {
            amount: {
              token: rewardMint,
              amount: claimableAmountRaw.toString(),
              decimals: rewardDecimals.toString(),
            },
            ...(rewardToken?.priceUsd !== undefined && {
              priceUsd: rewardToken.priceUsd.toString(),
            }),
            ...(rewardUsdValue !== undefined && { usdValue: rewardUsdValue }),
          }
        })
        .filter((entry) => entry !== null)

      if (
        staked.length === 0 &&
        unbonding.length === 0 &&
        rewards.length === 0
      ) {
        continue
      }

      const positionUsdValue = sumUsdValues([
        ...stakingComponentUsdValues,
        ...rewardUsdValues,
      ])
      const hasVaultConversion =
        stakedVaultUnderlying !== null || pendingVaultUnderlying !== null
      const hasStrategyConversion =
        stakedStrategyUnderlying !== null || pendingStrategyUnderlying !== null
      const hasStrategyInvestedLiquidity =
        farmStrategyAddress !== DEFAULT_PUBKEY &&
        strategyInvestedByAddress.has(farmStrategyAddress)

      const farmPosition: UserDefiPosition = {
        platformId: 'kamino',
        positionKind: 'staking',
        ...(positionUsdValue !== undefined && { usdValue: positionUsdValue }),
        ...(staked.length > 0 && { staked }),
        ...(unbonding.length > 0 && { unbonding }),
        ...(rewards.length > 0 && { rewards }),
        ...((hasStrategyConversion || hasVaultConversion) && {
          meta: {
            kamino: hasStrategyConversion
              ? {
                  source: 'farm-strategy',
                  farm: farmAddress,
                  strategy: farmStrategyAddress,
                  shareMint: stakedShareMint,
                  shareAmountRaw: stakedShareAmountRaw.toString(),
                  pendingShareAmountRaw:
                    pendingWithdrawalShareAmountRaw.toString(),
                  tokenAMint: farmStrategy?.tokenAMint,
                  tokenBMint: farmStrategy?.tokenBMint,
                  strategyDex: farmStrategy?.strategyDex,
                  includesInvestedLiquidity: hasStrategyInvestedLiquidity,
                  valuationSource: 'strategySnapshot',
                }
              : {
                  source: 'farm-vault',
                  farm: farmAddress,
                  vault: farmVaultAddress,
                  shareMint: stakedShareMint,
                  shareAmountRaw: stakedShareAmountRaw.toString(),
                  pendingShareAmountRaw:
                    pendingWithdrawalShareAmountRaw.toString(),
                  valuationSource: 'vaultSnapshot',
                },
          },
        }),
      }
      farmsPositions.push(farmPosition)
      farmsPositionsWithAddress.push({
        position: farmPosition,
        farmAddress,
        farmVaultAddress,
        farmStrategyAddress,
      })
    }

    const kaminoCatalogAndStrategyRequests: ProgramRequest[] = [
      {
        kind: 'getHttpJson',
        url: KAMINO_KVAULTS_LIST_URL,
        cacheTtlMs: KAMINO_APY_CACHE_TTL_MS,
      },
      {
        kind: 'getHttpJson',
        url: KAMINO_STRATEGIES_METRICS_URL,
        cacheTtlMs: KAMINO_APY_CACHE_TTL_MS,
      },
    ]
    const kaminoCatalogAndStrategyMap = yield kaminoCatalogAndStrategyRequests
    const kaminoRowsByUrl = groupHttpJsonRowsByUrl(kaminoCatalogAndStrategyMap)
    const { farmToVault, vaultAddresses: knownVaultAddresses } =
      parseKaminoVaultCatalog(
        kaminoRowsByUrl.get(KAMINO_KVAULTS_LIST_URL) ?? [],
      )
    const strategyApyByAddress = parseKaminoStrategyApyMap(
      kaminoRowsByUrl.get(KAMINO_STRATEGIES_METRICS_URL) ?? [],
    )

    const vaultAddressesToFetchApy = new Set<string>()
    for (const vaultAddress of kvaultVaultAddressByPosition.values()) {
      if (
        knownVaultAddresses.size > 0 &&
        !knownVaultAddresses.has(vaultAddress)
      ) {
        continue
      }
      vaultAddressesToFetchApy.add(vaultAddress)
    }

    const getFarmApyCandidateVaultAddresses = (
      farmAddress: string,
      farmVaultAddress: string,
    ): string[] => {
      const candidates: string[] = []
      const mappedVaultAddress = farmToVault.get(farmAddress)

      if (farmVaultAddress !== DEFAULT_PUBKEY) {
        if (
          knownVaultAddresses.size === 0 ||
          knownVaultAddresses.has(farmVaultAddress)
        ) {
          candidates.push(farmVaultAddress)
        }
      }

      if (
        mappedVaultAddress &&
        (knownVaultAddresses.size === 0 ||
          knownVaultAddresses.has(mappedVaultAddress)) &&
        !candidates.includes(mappedVaultAddress)
      ) {
        candidates.push(mappedVaultAddress)
      }

      return candidates
    }

    for (const farmPosition of farmsPositionsWithAddress) {
      const candidateVaultAddresses = getFarmApyCandidateVaultAddresses(
        farmPosition.farmAddress,
        farmPosition.farmVaultAddress,
      )
      for (const vaultAddress of candidateVaultAddresses) {
        vaultAddressesToFetchApy.add(vaultAddress)
      }
    }

    const vaultMetricsRequests: ProgramRequest[] = [
      ...vaultAddressesToFetchApy,
    ].map((vaultAddress) => ({
      kind: 'getHttpJson',
      url: getKaminoVaultMetricsUrl(vaultAddress),
      cacheTtlMs: KAMINO_APY_CACHE_TTL_MS,
    }))
    const vaultMetricsMap =
      vaultMetricsRequests.length > 0 ? yield vaultMetricsRequests : {}
    const vaultApyByAddress = parseKaminoVaultApyMap(
      groupHttpJsonRowsByUrl(vaultMetricsMap),
      vaultAddressesToFetchApy,
    )

    for (const [
      position,
      vaultAddress,
    ] of kvaultVaultAddressByPosition.entries()) {
      const apy = vaultApyByAddress.get(vaultAddress)
      if (apy === undefined) continue
      if (position.positionKind === 'staking') position.apy = apy
    }
    for (const farmPosition of farmsPositionsWithAddress) {
      if (farmPosition.farmStrategyAddress !== DEFAULT_PUBKEY) {
        const strategyApy = strategyApyByAddress.get(
          farmPosition.farmStrategyAddress,
        )
        if (
          strategyApy !== undefined &&
          farmPosition.position.positionKind === 'staking'
        ) {
          farmPosition.position.apy = strategyApy
          continue
        }
      }

      const candidateVaultAddresses = getFarmApyCandidateVaultAddresses(
        farmPosition.farmAddress,
        farmPosition.farmVaultAddress,
      )
      const apy = candidateVaultAddresses
        .map((vaultAddress) => vaultApyByAddress.get(vaultAddress))
        .find((value): value is string => value !== undefined)
      if (apy === undefined) continue
      if (farmPosition.position.positionKind === 'staking') {
        farmPosition.position.apy = apy
      }
    }

    const positions = [
      ...lendingPositions,
      ...kvaultSharePositions,
      ...farmsPositions,
    ]
    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: KLEND_PROGRAM_ID,
      discriminator: Obligation.discriminator,
      ownerOffset: 64,
    },
    {
      programId: FARMS_PROGRAM_ID,
      discriminator: UserState.discriminator,
      dataSize: UserState.layout.span + 8,
      ownerOffset: 48,
    },
  ],
}

export default kaminoIntegration
