import { BorshCoder } from '@coral-xyz/anchor'
import { borrowPda, lendingPda } from '@jup-ag/lend'
import { getRatioAtTick, INIT_TICK, MIN_TICK } from '@jup-ag/lend/borrow'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  ProgramRequest,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilter,
  UsersFilterPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'
import lendingIdl from './idls/lending.json'
import vaultsIdl from './idls/vaults.json'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

// ─── Program IDs ─────────────────────────────────────────────────────────────
const LENDING_PROGRAM_ID = lendingIdl.address
const VAULTS_PROGRAM_ID = vaultsIdl.address
const LIQUIDITY_PROGRAM_ID = 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC'
const ONE_HOUR_IN_MS = 60 * 60 * 1000
export const PROGRAM_IDS = [
  LENDING_PROGRAM_ID,
  VAULTS_PROGRAM_ID,
  LIQUIDITY_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

// ─── Exchange precision (1e12) ────────────────────────────────────────────────
const EXCHANGE_PRECISION = BigInt('1000000000000')
const INIT_TICK_VALUE = INIT_TICK // -2147483648
const MIN_TICK_VALUE = MIN_TICK // -16383
const INTERNAL_VAULT_DECIMALS = 9
const FOUR_DECIMALS = 10_000n
const RATE_OUTPUT_DECIMALS = 100_000_000_000_000_000n // 1e17
const RATE_SCALE = 1_000_000_000_000n // 1e12
const RATE_SCALE_DECIMALS = 12
const RATE_PERCENT_MULTIPLIER = 100n
const RATE_SCALE_PER_BPS = RATE_SCALE / FOUR_DECIMALS // 1e8

const lendingCoder = new BorshCoder(lendingIdl as never)
const vaultsCoder = new BorshCoder(vaultsIdl as never)

function accountDiscriminatorBase64(
  idl: { accounts?: Array<{ name: string; discriminator?: number[] }> },
  accountName: string,
): string {
  const discriminator = idl.accounts?.find(
    (account) => account.name === accountName,
  )?.discriminator
  if (!discriminator) {
    throw new Error(`Missing discriminator for account "${accountName}"`)
  }
  return Buffer.from(discriminator).toString('base64')
}

// Discriminator bytes for getProgramAccounts memcmp filters
const LENDING_DISC_B64 = accountDiscriminatorBase64(lendingIdl, 'Lending')
const POSITION_DISC_B64 = accountDiscriminatorBase64(vaultsIdl, 'Position')
const VAULT_CONFIG_DISC_B64 = accountDiscriminatorBase64(
  vaultsIdl,
  'VaultConfig',
)
const VAULT_STATE_DISC_B64 = accountDiscriminatorBase64(vaultsIdl, 'VaultState')
const VAULT_METADATA_DISC_B64 = accountDiscriminatorBase64(
  vaultsIdl,
  'VaultMetadata',
)
const USER_SUPPLY_POSITION_DISC_B64 = accountDiscriminatorBase64(
  vaultsIdl,
  'UserSupplyPosition',
)
const USER_BORROW_POSITION_DISC_B64 = accountDiscriminatorBase64(
  vaultsIdl,
  'UserBorrowPosition',
)

// SPL token account: amount at offset 64, mint at offset 0, owner at offset 32
const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const TOKEN_MINT_SUPPLY_OFFSET = 36
const DEFAULT_PUBKEY = PublicKey.default.toBase58()

// Position struct (Anchor bytemuck): discriminator (8) + fields (packed)
const POSITION_VAULT_ID_OFFSET = 8
const POSITION_NFT_ID_OFFSET = 10
const POSITION_MINT_OFFSET = 14
const POSITION_IS_SUPPLY_ONLY_OFFSET = 46
const POSITION_TICK_OFFSET = 47
const POSITION_SUPPLY_AMOUNT_OFFSET = 55
const POSITION_DUST_DEBT_AMOUNT_OFFSET = 63

type DecodedPosition = {
  nftId: number
  vaultId: number
  positionMint: string
  isSupplyOnly: boolean
  tick: number
  supplyAmount: bigint
  dustDebtAmount: bigint
}

type DecodedPositionWithAddress = DecodedPosition & {
  accountAddress: string
}

type UserLiquidityPositionKind = 'supply' | 'borrow'

type VaultConfigData = {
  address: string
  supplyToken: string
  borrowToken: string
  supplyRateMagnifier: number
  borrowRateMagnifier: number
}

type VaultStateData = {
  vaultSupplyExchangePrice: bigint
  vaultBorrowExchangePrice: bigint
}

type TokenReserveRateInputs = {
  mint: string
  borrowRate: number
  feeOnInterest: number
  lastUtilization: number
  supplyExchangePrice: bigint
  borrowExchangePrice: bigint
  totalSupplyWithInterest: bigint
  totalSupplyInterestFree: bigint
  totalBorrowWithInterest: bigint
  totalBorrowInterestFree: bigint
}

export type TokenReserveAnnualRatesScaled = {
  supplyRateScaled: bigint
  borrowRateScaled: bigint
}

type LendingRewardsRateModelInput = {
  startTvl: bigint
  duration: bigint
  startTime: bigint
  yearlyReward: bigint
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.slice(offset, offset + 32)).toBase58()
}

function readU16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset)
}

function readU32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset)
}

function readI32LE(buf: Buffer, offset: number): number {
  return buf.readInt32LE(offset)
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset)
}

function readTokenAccountAmount(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return null
  return readU64LE(buf, TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function readTokenAccountMint(data: Uint8Array): string | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_MINT_OFFSET + 32) return null
  return readPubkey(buf, TOKEN_ACCOUNT_MINT_OFFSET)
}

function readTokenMintSupply(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_MINT_SUPPLY_OFFSET + 8) return null
  return readU64LE(buf, TOKEN_MINT_SUPPLY_OFFSET)
}

function readDiscriminatorBase64(data: Uint8Array): string | null {
  if (data.length < 8) return null
  return Buffer.from(data.subarray(0, 8)).toString('base64')
}

function parsePositionAccount(data: Uint8Array): DecodedPosition | null {
  const buf = Buffer.from(data)
  if (buf.length < POSITION_DUST_DEBT_AMOUNT_OFFSET + 8) return null

  return {
    nftId: readU32LE(buf, POSITION_NFT_ID_OFFSET),
    vaultId: readU16LE(buf, POSITION_VAULT_ID_OFFSET),
    positionMint: readPubkey(buf, POSITION_MINT_OFFSET),
    isSupplyOnly: buf[POSITION_IS_SUPPLY_ONLY_OFFSET] !== 0,
    tick: readI32LE(buf, POSITION_TICK_OFFSET),
    supplyAmount: readU64LE(buf, POSITION_SUPPLY_AMOUNT_OFFSET),
    dustDebtAmount: readU64LE(buf, POSITION_DUST_DEBT_AMOUNT_OFFSET),
  }
}

/**
 * Recover netDebtRaw from the position's tick and supplyAmount.
 * Aligns with Jupiter SDK rounding:
 * netDebtRaw = ((colRaw + 1) * getRatioAtTick(tick) >> 48) + 1
 * Total debt raw = netDebtRaw + dustDebtAmount.
 */
function computeNetDebtRaw(
  supplyAmount: bigint,
  tick: number,
  isSupplyOnly: boolean,
): bigint {
  if (isSupplyOnly || tick === INIT_TICK_VALUE || tick <= MIN_TICK_VALUE)
    return 0n
  const colBN = new BN(supplyAmount.toString()).addn(1)
  const ratio = getRatioAtTick(tick)
  return BigInt(colBN.mul(ratio).shrn(48).addn(1).toString())
}

export function denormalizeVaultAmount(
  amount: bigint,
  mintDecimals: number,
): bigint {
  if (mintDecimals >= INTERNAL_VAULT_DECIMALS) return amount
  const delta = INTERNAL_VAULT_DECIMALS - mintDecimals
  return amount / 10n ** BigInt(delta)
}

export function formatScaledRate(rateScaled: bigint): string {
  const negative = rateScaled < 0n
  const absValue = negative ? -rateScaled : rateScaled
  const scaledPercent = absValue * RATE_PERCENT_MULTIPLIER
  const integerPart = scaledPercent / RATE_SCALE
  const fractionalPart = scaledPercent % RATE_SCALE

  if (fractionalPart === 0n) {
    return `${negative ? '-' : ''}${integerPart}`
  }

  const fractionalStr = fractionalPart
    .toString()
    .padStart(RATE_SCALE_DECIMALS, '0')
    .replace(/0+$/, '')

  return `${negative ? '-' : ''}${integerPart}.${fractionalStr}`
}

function negateRateString(rate: string): string {
  return rate.startsWith('-') ? rate.slice(1) : `-${rate}`
}

function toBigIntSafe(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null
    return BigInt(value)
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    try {
      return BigInt(value.toString())
    } catch {
      return null
    }
  }
  return null
}

function getWithInterestVsFreeRatio(
  withInterest: bigint,
  interestFree: bigint,
): bigint {
  if (withInterest > interestFree) {
    return (interestFree * FOUR_DECIMALS) / withInterest
  }
  if (withInterest < interestFree) {
    return (withInterest * FOUR_DECIMALS) / interestFree
  }
  return withInterest > 0n ? FOUR_DECIMALS : 0n
}

export function calculateTokenReserveAnnualRatesScaled(
  reserve: TokenReserveRateInputs,
): TokenReserveAnnualRatesScaled | null {
  if (reserve.borrowRate < 0 || reserve.feeOnInterest < 0) return null
  if (reserve.feeOnInterest > Number(FOUR_DECIMALS)) return null

  const borrowRate = BigInt(reserve.borrowRate)
  const utilization = BigInt(Math.max(reserve.lastUtilization, 0))
  const feeOnInterest = BigInt(reserve.feeOnInterest)

  const borrowRateScaled = (borrowRate * RATE_SCALE) / FOUR_DECIMALS
  let supplyRateScaled = 0n

  if (
    borrowRate > 0n &&
    reserve.totalBorrowWithInterest > 0n &&
    reserve.totalSupplyWithInterest > 0n
  ) {
    const supplyRatio = getWithInterestVsFreeRatio(
      reserve.totalSupplyWithInterest,
      reserve.totalSupplyInterestFree,
    )

    let ratioSupplyYield: bigint
    if (reserve.totalSupplyWithInterest < reserve.totalSupplyInterestFree) {
      if (supplyRatio === 0n) {
        return { supplyRateScaled, borrowRateScaled }
      }

      const invertedSupplyRatio =
        (RATE_OUTPUT_DECIMALS * FOUR_DECIMALS) / supplyRatio
      ratioSupplyYield =
        (utilization * (RATE_OUTPUT_DECIMALS + invertedSupplyRatio)) /
        FOUR_DECIMALS
    } else {
      ratioSupplyYield =
        (utilization * RATE_OUTPUT_DECIMALS * (FOUR_DECIMALS + supplyRatio)) /
        (FOUR_DECIMALS * FOUR_DECIMALS)
    }

    const borrowRatio = getWithInterestVsFreeRatio(
      reserve.totalBorrowWithInterest,
      reserve.totalBorrowInterestFree,
    )

    const borrowYieldShare =
      reserve.totalBorrowWithInterest < reserve.totalBorrowInterestFree
        ? (borrowRatio * RATE_OUTPUT_DECIMALS) / (FOUR_DECIMALS + borrowRatio)
        : RATE_OUTPUT_DECIMALS -
          (borrowRatio * RATE_OUTPUT_DECIMALS) / (FOUR_DECIMALS + borrowRatio)

    ratioSupplyYield =
      (ratioSupplyYield * borrowYieldShare * FOUR_DECIMALS) /
      RATE_OUTPUT_DECIMALS /
      RATE_OUTPUT_DECIMALS

    supplyRateScaled =
      borrowRate * ratioSupplyYield * (FOUR_DECIMALS - feeOnInterest)
  }

  return { supplyRateScaled, borrowRateScaled }
}

export function applyRateMagnifierToScale(
  baseRateScaled: bigint,
  magnifier: number,
): bigint {
  return baseRateScaled + BigInt(magnifier) * RATE_SCALE_PER_BPS
}

export function calculateEarnBaseSupplyRateScaled(
  reserve: TokenReserveRateInputs,
): bigint {
  const borrowWithInterestForRate =
    (reserve.totalBorrowWithInterest * reserve.borrowExchangePrice) /
    EXCHANGE_PRECISION
  const supplyWithInterestForRate =
    (reserve.totalSupplyWithInterest * reserve.supplyExchangePrice) /
    EXCHANGE_PRECISION

  if (supplyWithInterestForRate === 0n) return 0n

  const supplyRateBps =
    (BigInt(reserve.borrowRate) *
      (FOUR_DECIMALS - BigInt(reserve.feeOnInterest)) *
      borrowWithInterestForRate) /
    (supplyWithInterestForRate * FOUR_DECIMALS)

  return (supplyRateBps * RATE_SCALE) / FOUR_DECIMALS
}

function decodeLendingRewardsRateModel(
  data: Uint8Array,
): LendingRewardsRateModelInput | null {
  try {
    const decoded = lendingCoder.accounts.decode(
      'LendingRewardsRateModel',
      Buffer.from(data),
    )
    const startTvl = toBigIntSafe(decoded.start_tvl)
    const duration = toBigIntSafe(decoded.duration)
    const startTime = toBigIntSafe(decoded.start_time)
    const yearlyReward = toBigIntSafe(decoded.yearly_reward)
    if (
      startTvl === null ||
      duration === null ||
      startTime === null ||
      yearlyReward === null
    ) {
      return null
    }
    return { startTvl, duration, startTime, yearlyReward }
  } catch {
    return null
  }
}

function calculateEarnRewardsRateScaled(
  model: LendingRewardsRateModelInput,
  tokenExchangePrice: bigint,
  fTokenSupply: bigint,
): bigint {
  if (model.startTime === 0n || model.duration === 0n) return 0n

  const now = BigInt(Math.floor(Date.now() / 1000))
  if (now > model.startTime + model.duration) return 0n

  const totalAssets = (tokenExchangePrice * fTokenSupply) / EXCHANGE_PRECISION
  if (totalAssets === 0n || totalAssets < model.startTvl) return 0n

  const rewardsRateBps = (model.yearlyReward * FOUR_DECIMALS) / totalAssets
  return (rewardsRateBps * RATE_SCALE) / FOUR_DECIMALS
}

function deriveLiquidityPdas(
  mint: string,
): { reserveAddress: string; rateModelAddress: string } | null {
  try {
    const mintPubkey = new PublicKey(mint)
    return {
      reserveAddress: borrowPda.getLiquidityReserve(mintPubkey).toBase58(),
      rateModelAddress: borrowPda.getRateModel(mintPubkey).toBase58(),
    }
  } catch {
    return null
  }
}

export function deriveUserLiquidityPositionPdas(
  mint: string,
  protocol: string,
): { supplyPositionAddress: string; borrowPositionAddress: string } | null {
  try {
    const mintPubkey = new PublicKey(mint)
    const protocolPubkey = new PublicKey(protocol)
    return {
      supplyPositionAddress: borrowPda
        .getUserSupplyPosition(mintPubkey, protocolPubkey)
        .toBase58(),
      borrowPositionAddress: borrowPda
        .getUserBorrowPosition(mintPubkey, protocolPubkey)
        .toBase58(),
    }
  } catch {
    return null
  }
}

function toMintProtocolKey(mint: string, protocol: string): string {
  return `${mint}:${protocol}`
}

export function buildTokenHolderUsersFiltersByMints(
  mints: Iterable<string>,
): UsersFilter[] {
  const filters: UsersFilter[] = []
  const tokenProgramId = TOKEN_PROGRAM_ID.toBase58()

  for (const mint of new Set(mints)) {
    let mintBytes: Uint8Array
    try {
      mintBytes = new PublicKey(mint).toBytes()
    } catch {
      continue
    }

    filters.push({
      programId: tokenProgramId,
      ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
      dataSize: 165,
      memcmps: [{ offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mintBytes }],
    })
  }

  return filters
}

export function buildVaultPositionLookupRequest(
  positionMint: string,
): ProgramRequest {
  return {
    kind: 'getProgramAccounts',
    programId: VAULTS_PROGRAM_ID,
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: POSITION_DISC_B64,
          encoding: 'base64',
        },
      },
      {
        memcmp: {
          offset: POSITION_MINT_OFFSET,
          bytes: positionMint,
          encoding: 'base58',
        },
      },
    ],
  }
}

function decodeUserLiquidityPositionAccount(
  kind: UserLiquidityPositionKind,
  data: Uint8Array,
): { mint: string; protocol: string; amount: bigint } | null {
  try {
    const decoded = vaultsCoder.accounts.decode(
      kind === 'supply' ? 'UserSupplyPosition' : 'UserBorrowPosition',
      Buffer.from(data),
    ) as {
      protocol: PublicKey
      mint: PublicKey
      amount: unknown
    }

    const amount = toBigIntSafe(decoded.amount)
    if (amount === null) return null

    return {
      mint: decoded.mint.toBase58(),
      protocol: decoded.protocol.toBase58(),
      amount,
    }
  } catch {
    return null
  }
}

function isLendingPdaValid(mint: string, accountAddress: string): boolean {
  try {
    const expected = lendingPda.getLending(new PublicKey(mint)).toBase58()
    return expected === accountAddress
  } catch {
    return false
  }
}

function isPositionPdaValid(position: DecodedPositionWithAddress): boolean {
  try {
    const expectedPosition = borrowPda
      .getPosition(position.vaultId, position.nftId)
      .toBase58()
    if (expectedPosition !== position.accountAddress) return false

    const expectedMint = borrowPda
      .getPositionMint(position.vaultId, position.nftId)
      .toBase58()
    return expectedMint === position.positionMint
  } catch {
    return false
  }
}

function decodeTokenReserveRateInputs(
  data: Uint8Array,
): TokenReserveRateInputs | null {
  const decodeWithCoder = (
    coder: BorshCoder,
  ): TokenReserveRateInputs | null => {
    try {
      const decoded = coder.accounts.decode('TokenReserve', Buffer.from(data))
      const mint = (decoded.mint as PublicKey).toBase58()
      const totalSupplyWithInterest = toBigIntSafe(
        decoded.total_supply_with_interest,
      )
      const totalSupplyInterestFree = toBigIntSafe(
        decoded.total_supply_interest_free,
      )
      const totalBorrowWithInterest = toBigIntSafe(
        decoded.total_borrow_with_interest,
      )
      const totalBorrowInterestFree = toBigIntSafe(
        decoded.total_borrow_interest_free,
      )
      const supplyExchangePrice = toBigIntSafe(decoded.supply_exchange_price)
      const borrowExchangePrice = toBigIntSafe(decoded.borrow_exchange_price)
      if (
        totalSupplyWithInterest === null ||
        totalSupplyInterestFree === null ||
        totalBorrowWithInterest === null ||
        totalBorrowInterestFree === null ||
        supplyExchangePrice === null ||
        borrowExchangePrice === null
      ) {
        return null
      }

      return {
        mint,
        borrowRate: Number(decoded.borrow_rate),
        feeOnInterest: Number(decoded.fee_on_interest),
        lastUtilization: Number(decoded.last_utilization),
        supplyExchangePrice,
        borrowExchangePrice,
        totalSupplyWithInterest,
        totalSupplyInterestFree,
        totalBorrowWithInterest,
        totalBorrowInterestFree,
      }
    } catch {
      return null
    }
  }

  return decodeWithCoder(lendingCoder) ?? decodeWithCoder(vaultsCoder)
}

// ─── Integration ─────────────────────────────────────────────────────────────

export const jupiterLendIntegration: SolanaIntegration = {
  platformId: 'jupiter',

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

    const walletPubkey = new PublicKey(address)
    const walletAddress = walletPubkey.toBase58()

    // ── Phase 0: Discover all required datasets in parallel ──────────────────
    const discoveryRequests: ProgramRequest[] = [
      // {
      //   kind: 'getProgramAccounts',
      //   programId: LENDING_PROGRAM_ID,
      //   cacheTtlMs: ONE_HOUR_IN_MS,
      //   filters: [
      //     {
      //       memcmp: {
      //         offset: 0,
      //         bytes: LENDING_DISC_B64,
      //         encoding: 'base64',
      //       },
      //     },
      //   ],
      // },
      {
        kind: 'getTokenAccountsByOwner',
        owner: walletAddress,
        programId: TOKEN_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getTokenAccountsByOwner',
        owner: walletAddress,
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getProgramAccounts',
        programId: VAULTS_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: VAULT_CONFIG_DISC_B64,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts',
        programId: VAULTS_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: VAULT_STATE_DISC_B64,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts',
        programId: VAULTS_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: VAULT_METADATA_DISC_B64,
              encoding: 'base64',
            },
          },
        ],
      },
    ]
    const discoveryMap = yield discoveryRequests

    const earnPools: Array<{
      mint: string
      fTokenMint: string
      lendingAddress: string
      decimals: number
      tokenExchangePrice: bigint
      rewardsRateModel: string
    }> = []
    const validatedEarnMints = new Set<string>()

    // Build mint → amount map for all user SPL token accounts.
    const userMintBalances = new Map<string, bigint>()

    const positionsByMint = new Map<string, DecodedPositionWithAddress>()
    const validatedPositionMints = new Set<string>()

    const vaultConfigMap = new Map<number, VaultConfigData>()
    const validatedVaultConfigMap = new Map<number, VaultConfigData>()
    const vaultStateMap = new Map<number, VaultStateData>()
    const validatedVaultStateMap = new Map<number, VaultStateData>()
    const vaultMetaMap = new Map<
      number,
      { supplyDecimals: number; borrowDecimals: number }
    >()

    for (const acc of Object.values(discoveryMap)) {
      if (!acc.exists) continue

      if (acc.programAddress === LENDING_PROGRAM_ID) {
        try {
          const d = lendingCoder.accounts.decode(
            'Lending',
            Buffer.from(acc.data),
          )
          earnPools.push({
            mint: (d.mint as PublicKey).toBase58(),
            fTokenMint: (d.f_token_mint as PublicKey).toBase58(),
            lendingAddress: acc.address,
            decimals: d.decimals as number,
            tokenExchangePrice: BigInt(
              (d.token_exchange_price as BN).toString(),
            ),
            rewardsRateModel: (d.rewards_rate_model as PublicKey).toBase58(),
          })
          if (
            isLendingPdaValid((d.mint as PublicKey).toBase58(), acc.address)
          ) {
            validatedEarnMints.add((d.mint as PublicKey).toBase58())
          }
        } catch {
          // skip accounts that fail to decode
        }
        continue
      }

      if (
        acc.programAddress === TOKEN_PROGRAM_ID.toBase58() ||
        acc.programAddress === TOKEN_2022_PROGRAM_ID.toBase58()
      ) {
        const mint = readTokenAccountMint(acc.data)
        const amount = readTokenAccountAmount(acc.data)
        if (mint && amount !== null && amount > 0n) {
          userMintBalances.set(
            mint,
            (userMintBalances.get(mint) ?? 0n) + amount,
          )
        }
        continue
      }

      if (acc.programAddress !== VAULTS_PROGRAM_ID) continue

      const discriminator = readDiscriminatorBase64(acc.data)
      if (discriminator === VAULT_CONFIG_DISC_B64) {
        try {
          const d = vaultsCoder.accounts.decode(
            'VaultConfig',
            Buffer.from(acc.data),
          )
          const vaultId = d.vault_id as number
          const cfg: VaultConfigData = {
            address: acc.address,
            supplyToken: (d.supply_token as PublicKey).toBase58(),
            borrowToken: (d.borrow_token as PublicKey).toBase58(),
            supplyRateMagnifier: d.supply_rate_magnifier as number,
            borrowRateMagnifier: d.borrow_rate_magnifier as number,
          }
          if (!vaultConfigMap.has(vaultId)) {
            vaultConfigMap.set(vaultId, cfg)
          }
          if (borrowPda.getVaultConfig(vaultId).toBase58() === acc.address) {
            validatedVaultConfigMap.set(vaultId, cfg)
          }
        } catch {
          // skip accounts that fail to decode
        }
        continue
      }

      if (discriminator === VAULT_STATE_DISC_B64) {
        try {
          const d = vaultsCoder.accounts.decode(
            'VaultState',
            Buffer.from(acc.data),
          )
          const vaultId = d.vault_id as number
          const state: VaultStateData = {
            vaultSupplyExchangePrice: BigInt(
              (d.vault_supply_exchange_price as BN).toString(),
            ),
            vaultBorrowExchangePrice: BigInt(
              (d.vault_borrow_exchange_price as BN).toString(),
            ),
          }
          if (!vaultStateMap.has(vaultId)) {
            vaultStateMap.set(vaultId, state)
          }
          if (borrowPda.getVaultState(vaultId).toBase58() === acc.address) {
            validatedVaultStateMap.set(vaultId, state)
          }
        } catch {
          // skip accounts that fail to decode
        }
        continue
      }

      if (discriminator === VAULT_METADATA_DISC_B64) {
        try {
          const d = vaultsCoder.accounts.decode(
            'VaultMetadata',
            Buffer.from(acc.data),
          )
          vaultMetaMap.set(d.vault_id as number, {
            supplyDecimals: d.supply_mint_decimals as number,
            borrowDecimals: d.borrow_mint_decimals as number,
          })
        } catch {
          // skip accounts that fail to decode
        }
      }
    }

    // Derive and fetch user liquidity positions from matched wallet and program mints.
    const userHeldMints = new Set(userMintBalances.keys())
    const mintProtocolPairs = new Map<
      string,
      { mint: string; protocol: string }
    >()
    const addMintProtocolPair = (mint: string, protocol: string) => {
      mintProtocolPairs.set(toMintProtocolKey(mint, protocol), {
        mint,
        protocol,
      })
    }

    for (const pool of earnPools) {
      if (!validatedEarnMints.has(pool.mint)) continue
      if (
        !userHeldMints.has(pool.fTokenMint) &&
        !userHeldMints.has(pool.mint)
      ) {
        continue
      }
      addMintProtocolPair(pool.mint, pool.lendingAddress)
    }

    for (const cfg of validatedVaultConfigMap.values()) {
      if (userHeldMints.has(cfg.supplyToken)) {
        addMintProtocolPair(cfg.supplyToken, cfg.address)
      }
      if (userHeldMints.has(cfg.borrowToken)) {
        addMintProtocolPair(cfg.borrowToken, cfg.address)
      }
    }

    const expectedDerivedUserPositions = new Map<
      string,
      { mint: string; protocol: string; kind: UserLiquidityPositionKind }
    >()
    for (const pair of mintProtocolPairs.values()) {
      const pdas = deriveUserLiquidityPositionPdas(pair.mint, pair.protocol)
      if (!pdas) continue

      expectedDerivedUserPositions.set(pdas.supplyPositionAddress, {
        mint: pair.mint,
        protocol: pair.protocol,
        kind: 'supply',
      })
      expectedDerivedUserPositions.set(pdas.borrowPositionAddress, {
        mint: pair.mint,
        protocol: pair.protocol,
        kind: 'borrow',
      })
    }

    const derivedUserPositionsMap =
      expectedDerivedUserPositions.size > 0
        ? yield [...expectedDerivedUserPositions.keys()]
        : {}

    const derivedSupplyPositionPairs = new Set<string>()

    for (const [
      addressKey,
      expected,
    ] of expectedDerivedUserPositions.entries()) {
      const account = derivedUserPositionsMap[addressKey]
      if (!account?.exists) continue
      if (account.programAddress !== LIQUIDITY_PROGRAM_ID) continue

      const expectedDisc =
        expected.kind === 'supply'
          ? USER_SUPPLY_POSITION_DISC_B64
          : USER_BORROW_POSITION_DISC_B64
      if (readDiscriminatorBase64(account.data) !== expectedDisc) continue

      const decoded = decodeUserLiquidityPositionAccount(
        expected.kind,
        account.data,
      )
      if (!decoded) continue
      if (decoded.mint !== expected.mint) continue
      if (decoded.protocol !== expected.protocol) continue

      if (expected.kind === 'supply' && decoded.amount > 0n) {
        derivedSupplyPositionPairs.add(
          toMintProtocolKey(decoded.mint, decoded.protocol),
        )
      }
    }

    // Wallet position mints are NFT-like token balances with amount=1.
    const userPositionMints = [...userMintBalances.entries()]
      .filter(([, amount]) => amount === 1n)
      .map(([mint]) => mint)

    const positionLookupRequests = userPositionMints.map(
      buildVaultPositionLookupRequest,
    )
    const positionLookupMap =
      positionLookupRequests.length > 0 ? yield positionLookupRequests : {}

    for (const acc of Object.values(positionLookupMap)) {
      if (!acc.exists) continue
      if (acc.programAddress !== VAULTS_PROGRAM_ID) continue
      if (readDiscriminatorBase64(acc.data) !== POSITION_DISC_B64) continue

      const parsed = parsePositionAccount(acc.data)
      if (!parsed || parsed.supplyAmount === 0n) continue
      if (positionsByMint.has(parsed.positionMint)) continue

      const positionWithAddress: DecodedPositionWithAddress = {
        ...parsed,
        accountAddress: acc.address,
      }
      positionsByMint.set(parsed.positionMint, positionWithAddress)
      if (isPositionPdaValid(positionWithAddress)) {
        validatedPositionMints.add(parsed.positionMint)
      }
    }

    const ownedPositions: DecodedPositionWithAddress[] = []
    for (const positionMint of userPositionMints) {
      const position = positionsByMint.get(positionMint)
      if (!position) continue
      ownedPositions.push(position)
    }

    // ── Phase 2: Strict APY inputs (reserve + rate model PDAs) ───────────────
    const mintsNeedingRates = new Set<string>()

    for (const pool of earnPools) {
      if (
        validatedEarnMints.has(pool.mint) &&
        derivedSupplyPositionPairs.has(
          toMintProtocolKey(pool.mint, pool.lendingAddress),
        )
      ) {
        mintsNeedingRates.add(pool.mint)
      }
    }

    for (const pos of ownedPositions) {
      if (!validatedPositionMints.has(pos.positionMint)) continue
      const apyCfg = validatedVaultConfigMap.get(pos.vaultId)
      const apyState = validatedVaultStateMap.get(pos.vaultId)
      if (!apyCfg || !apyState) continue
      mintsNeedingRates.add(apyCfg.supplyToken)
      mintsNeedingRates.add(apyCfg.borrowToken)
    }

    const reserveAddressByMint = new Map<string, string>()
    const rateModelAddressByMint = new Map<string, string>()
    const rewardsModelAddressByMint = new Map<string, string>()
    const fTokenMintByMint = new Map<string, string>()
    for (const mint of mintsNeedingRates) {
      const pdas = deriveLiquidityPdas(mint)
      if (!pdas) continue
      reserveAddressByMint.set(mint, pdas.reserveAddress)
      rateModelAddressByMint.set(mint, pdas.rateModelAddress)
    }
    for (const pool of earnPools) {
      if (!validatedEarnMints.has(pool.mint)) continue
      fTokenMintByMint.set(pool.mint, pool.fTokenMint)
      if (pool.rewardsRateModel !== DEFAULT_PUBKEY) {
        rewardsModelAddressByMint.set(pool.mint, pool.rewardsRateModel)
      }
    }

    const rateInputAddresses = [
      ...new Set([
        ...reserveAddressByMint.values(),
        ...rateModelAddressByMint.values(),
        ...rewardsModelAddressByMint.values(),
        ...fTokenMintByMint.values(),
      ]),
    ]
    const rateInputsMap =
      rateInputAddresses.length > 0 ? yield rateInputAddresses : {}

    const baseRatesByMint = new Map<string, TokenReserveAnnualRatesScaled>()
    const earnSupplyRateByMint = new Map<string, bigint>()
    const earnRewardsRateByMint = new Map<string, bigint>()
    for (const [mint, reserveAddress] of reserveAddressByMint.entries()) {
      const reserveAccount = rateInputsMap[reserveAddress]
      if (!reserveAccount?.exists) continue

      const rateModelAddress = rateModelAddressByMint.get(mint)
      if (!rateModelAddress) continue
      const rateModelAccount = rateInputsMap[rateModelAddress]
      if (!rateModelAccount?.exists) continue

      const reserve = decodeTokenReserveRateInputs(reserveAccount.data)
      if (!reserve || reserve.mint !== mint) continue

      earnSupplyRateByMint.set(mint, calculateEarnBaseSupplyRateScaled(reserve))

      const rates = calculateTokenReserveAnnualRatesScaled(reserve)
      if (!rates) continue
      baseRatesByMint.set(mint, rates)
    }
    for (const pool of earnPools) {
      if (!validatedEarnMints.has(pool.mint)) continue
      if (pool.rewardsRateModel === DEFAULT_PUBKEY) {
        earnRewardsRateByMint.set(pool.mint, 0n)
        continue
      }

      const rewardsModelAccount = rateInputsMap[pool.rewardsRateModel]
      if (!rewardsModelAccount?.exists) continue
      const rewardModel = decodeLendingRewardsRateModel(
        rewardsModelAccount.data,
      )
      if (!rewardModel) continue

      const fTokenMintAccount = rateInputsMap[pool.fTokenMint]
      if (!fTokenMintAccount?.exists) continue
      const fTokenSupply = readTokenMintSupply(fTokenMintAccount.data)
      if (fTokenSupply === null) continue

      earnRewardsRateByMint.set(
        pool.mint,
        calculateEarnRewardsRateScaled(
          rewardModel,
          pool.tokenExchangePrice,
          fTokenSupply,
        ),
      )
    }

    const result: UserDefiPosition[] = []

    // ── Decode Earn positions ─────────────────────────────────────────────────
    for (const pool of earnPools) {
      const supplyPositionPair = toMintProtocolKey(
        pool.mint,
        pool.lendingAddress,
      )
      if (!derivedSupplyPositionPairs.has(supplyPositionPair)) continue

      const shares = userMintBalances.get(pool.fTokenMint) ?? 0n

      if (shares === 0n) continue

      const underlying = (shares * pool.tokenExchangePrice) / EXCHANGE_PRECISION
      if (underlying === 0n) continue

      const tokenInfo = tokens.get(pool.mint)
      const priceUsd = tokenInfo?.priceUsd
      const usdValue =
        priceUsd !== undefined
          ? ((Number(underlying) / 10 ** pool.decimals) * priceUsd).toString()
          : undefined
      const hasStrictEarnInputs =
        validatedEarnMints.has(pool.mint) &&
        derivedSupplyPositionPairs.has(supplyPositionPair)
      const earnSupplyRateScaled = hasStrictEarnInputs
        ? earnSupplyRateByMint.get(pool.mint)
        : undefined
      const supplyRate =
        earnSupplyRateScaled !== undefined
          ? formatScaledRate(earnSupplyRateScaled)
          : undefined
      const rewardsRateScaled = hasStrictEarnInputs
        ? earnRewardsRateByMint.get(pool.mint)
        : undefined
      const requiresRewards = pool.rewardsRateModel !== DEFAULT_PUBKEY
      const apyRate =
        earnSupplyRateScaled !== undefined &&
        (!requiresRewards || rewardsRateScaled !== undefined)
          ? earnSupplyRateScaled + (rewardsRateScaled ?? 0n)
          : undefined

      const supplied: LendingSuppliedAsset = {
        amount: {
          token: pool.mint,
          amount: underlying.toString(),
          decimals: pool.decimals.toString(),
        },
        ...(supplyRate !== undefined && { supplyRate }),
        ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
        ...(usdValue !== undefined && { usdValue }),
      }

      const earnPosition: LendingDefiPosition = {
        positionKind: 'lending',
        platformId: 'jupiter',
        supplied: [supplied],
        ...(usdValue !== undefined && { usdValue: usdValue }),
      }
      if (apyRate !== undefined) {
        earnPosition.apy = formatScaledRate(apyRate)
      }
      result.push(earnPosition)
    }

    // ── Decode CDP vault positions ────────────────────────────────────────────
    for (const pos of ownedPositions) {
      const cfg = vaultConfigMap.get(pos.vaultId)
      const state = vaultStateMap.get(pos.vaultId)
      const meta = vaultMetaMap.get(pos.vaultId)
      if (!cfg || !state) continue

      const apyCfg = validatedVaultConfigMap.get(pos.vaultId)
      const apyState = validatedVaultStateMap.get(pos.vaultId)
      const hasStrictApyInputs =
        validatedPositionMints.has(pos.positionMint) &&
        apyCfg !== undefined &&
        apyState !== undefined &&
        apyCfg.supplyToken === cfg.supplyToken &&
        apyCfg.borrowToken === cfg.borrowToken &&
        apyState.vaultSupplyExchangePrice === state.vaultSupplyExchangePrice &&
        apyState.vaultBorrowExchangePrice === state.vaultBorrowExchangePrice

      const supplyDecimals = meta?.supplyDecimals ?? 6
      const borrowDecimals = meta?.borrowDecimals ?? 6

      const colInternalAmount =
        (pos.supplyAmount * state.vaultSupplyExchangePrice) / EXCHANGE_PRECISION
      const colAmount = denormalizeVaultAmount(
        colInternalAmount,
        supplyDecimals,
      )

      const netDebtRaw = computeNetDebtRaw(
        pos.supplyAmount,
        pos.tick,
        pos.isSupplyOnly,
      )
      const totalDebtRaw = netDebtRaw + pos.dustDebtAmount
      const debtInternalAmount =
        (totalDebtRaw * state.vaultBorrowExchangePrice) / EXCHANGE_PRECISION
      const debtAmount = denormalizeVaultAmount(
        debtInternalAmount,
        borrowDecimals,
      )

      const supplyTokenInfo = tokens.get(cfg.supplyToken)
      const borrowTokenInfo = tokens.get(cfg.borrowToken)
      const supplyPriceUsd = supplyTokenInfo?.priceUsd
      const borrowPriceUsd = borrowTokenInfo?.priceUsd

      const colUsd =
        supplyPriceUsd !== undefined
          ? (Number(colAmount) / 10 ** supplyDecimals) * supplyPriceUsd
          : undefined
      const debtUsd =
        borrowPriceUsd !== undefined && debtAmount > 0n
          ? (Number(debtAmount) / 10 ** borrowDecimals) * borrowPriceUsd
          : undefined
      const baseSupplyRates =
        hasStrictApyInputs && apyCfg
          ? baseRatesByMint.get(apyCfg.supplyToken)
          : undefined
      const baseBorrowRates =
        hasStrictApyInputs && apyCfg
          ? baseRatesByMint.get(apyCfg.borrowToken)
          : undefined
      const supplyRate =
        baseSupplyRates !== undefined && apyCfg
          ? formatScaledRate(
              applyRateMagnifierToScale(
                baseSupplyRates.supplyRateScaled,
                apyCfg.supplyRateMagnifier,
              ),
            )
          : undefined
      const borrowRate =
        baseBorrowRates !== undefined && apyCfg
          ? formatScaledRate(
              applyRateMagnifierToScale(
                baseBorrowRates.borrowRateScaled,
                apyCfg.borrowRateMagnifier,
              ),
            )
          : undefined

      const supplied: LendingSuppliedAsset = {
        amount: {
          token: cfg.supplyToken,
          amount: colAmount.toString(),
          decimals: supplyDecimals.toString(),
        },
        ...(supplyRate !== undefined && { supplyRate }),
        ...(supplyPriceUsd !== undefined && {
          priceUsd: supplyPriceUsd.toString(),
        }),
        ...(colUsd !== undefined && { usdValue: colUsd.toString() }),
      }

      const positionResult: LendingDefiPosition = {
        positionKind: 'lending',
        platformId: 'jupiter',
        supplied: [supplied],
        ...(colUsd !== undefined && { usdValue: colUsd.toString() }),
      }

      if (debtAmount > 0n) {
        const borrowed: LendingBorrowedAsset = {
          amount: {
            token: cfg.borrowToken,
            amount: debtAmount.toString(),
            decimals: borrowDecimals.toString(),
          },
          ...(borrowRate !== undefined && { borrowRate }),
          ...(borrowPriceUsd !== undefined && {
            priceUsd: borrowPriceUsd.toString(),
          }),
          ...(debtUsd !== undefined && { usdValue: debtUsd.toString() }),
        }
        positionResult.borrowed = [borrowed]
        if (colUsd !== undefined && debtUsd !== undefined) {
          positionResult.usdValue = (colUsd - debtUsd).toString()
        }
      }

      if (supplyRate !== undefined) {
        positionResult.apy = supplyRate
      } else if (debtAmount > 0n && borrowRate !== undefined) {
        positionResult.apy = negateRateString(borrowRate)
      }

      result.push(positionResult)
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)

    return result
  },

  getUsersFilter: async function* (): UsersFilterPlan {
    const lendingAccounts = yield {
      kind: 'getProgramAccounts' as const,
      programId: LENDING_PROGRAM_ID,
      cacheTtlMs: ONE_HOUR_IN_MS,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: LENDING_DISC_B64,
            encoding: 'base64',
          },
        },
      ],
    }

    const discoveredMints = new Set<string>()
    for (const account of Object.values(lendingAccounts)) {
      if (!account.exists) continue
      if (account.programAddress !== LENDING_PROGRAM_ID) continue

      try {
        const decoded = lendingCoder.accounts.decode(
          'Lending',
          Buffer.from(account.data),
        ) as {
          mint: PublicKey
          f_token_mint: PublicKey
        }

        const lendingMint = decoded.mint.toBase58()
        if (!isLendingPdaValid(lendingMint, account.address)) continue

        discoveredMints.add(decoded.f_token_mint.toBase58())
      } catch {
        // skip accounts that fail to decode
      }
    }

    return buildTokenHolderUsersFiltersByMints(discoveredMints)
  },
}

export default jupiterLendIntegration
