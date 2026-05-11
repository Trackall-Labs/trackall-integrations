import { BN } from '@coral-xyz/anchor'
import type { WhirlpoolData } from '@orca-so/whirlpools-sdk'
import { ParsableWhirlpool, PoolUtil, PriceMath } from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'
import type {
  AccountsMap,
  ConstantProductLiquidityDefiPosition,
  LendingDefiPosition,
  LendingSuppliedAsset,
  MaybeSolanaAccount,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  TradingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'
import tunaIdl from './idls/tuna.json'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const TUNA_PROGRAM_ID = tunaIdl.address
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'
const MINT_DECIMALS_OFFSET = 44
const FIXED_POINT_SCALE = 1n << 60n
const SECONDS_PER_YEAR = 31_536_000n

const LENDING_POSITION_DISCRIMINATOR = accountDiscriminator(
  tunaIdl as {
    accounts?: Array<{ name: string; discriminator?: number[] }>
  },
  'LendingPosition',
)
const TUNA_LP_POSITION_DISCRIMINATOR = accountDiscriminator(
  tunaIdl as {
    accounts?: Array<{ name: string; discriminator?: number[] }>
  },
  'TunaLpPosition',
)
const TUNA_SPOT_POSITION_DISCRIMINATOR = accountDiscriminator(
  tunaIdl as {
    accounts?: Array<{ name: string; discriminator?: number[] }>
  },
  'TunaSpotPosition',
)
const MARKET_DISCRIMINATOR = accountDiscriminator(
  tunaIdl as {
    accounts?: Array<{ name: string; discriminator?: number[] }>
  },
  'Market',
)
const VAULT_DISCRIMINATOR = accountDiscriminator(
  tunaIdl as {
    accounts?: Array<{ name: string; discriminator?: number[] }>
  },
  'Vault',
)
const LENDING_POSITION_DISCRIMINATOR_B64 = discriminatorBase64(
  LENDING_POSITION_DISCRIMINATOR,
)
const TUNA_LP_POSITION_DISCRIMINATOR_B64 = discriminatorBase64(
  TUNA_LP_POSITION_DISCRIMINATOR,
)
const TUNA_SPOT_POSITION_DISCRIMINATOR_B64 = discriminatorBase64(
  TUNA_SPOT_POSITION_DISCRIMINATOR,
)
const MARKET_DISCRIMINATOR_B64 = discriminatorBase64(MARKET_DISCRIMINATOR)
const VAULT_DISCRIMINATOR_B64 = discriminatorBase64(VAULT_DISCRIMINATOR)

const LENDING_AUTHORITY_OFFSET = 11
const LENDING_MINT_OFFSET = 43
const LENDING_DEPOSITED_FUNDS_OFFSET = 75
const LENDING_DEPOSITED_SHARES_OFFSET = 83
const LENDING_VAULT_OFFSET = 91

const LP_AUTHORITY_OFFSET = 11
const LP_POOL_OFFSET = 43
const LP_MINT_A_OFFSET = 75
const LP_MINT_B_OFFSET = 107
const LP_POSITION_MINT_OFFSET = 139
const LP_LIQUIDITY_OFFSET = 171
const LP_TICK_LOWER_INDEX_OFFSET = 187
const LP_TICK_UPPER_INDEX_OFFSET = 191
const LP_LOAN_SHARES_A_OFFSET = 195
const LP_LOAN_SHARES_B_OFFSET = 203
const LP_LOAN_FUNDS_A_OFFSET = 211
const LP_LOAN_FUNDS_B_OFFSET = 219
const LP_LEFTOVERS_A_OFFSET = 227
const LP_LEFTOVERS_B_OFFSET = 235
const LP_COMPOUNDED_YIELD_A_OFFSET = 257
const LP_COMPOUNDED_YIELD_B_OFFSET = 265
const LP_MARKET_MAKER_OFFSET = 277

const SPOT_AUTHORITY_OFFSET = 11
const SPOT_POOL_OFFSET = 43
const SPOT_MINT_A_OFFSET = 75
const SPOT_MINT_B_OFFSET = 107
const SPOT_MARKET_MAKER_OFFSET = 139
const SPOT_POSITION_TOKEN_OFFSET = 140
const SPOT_COLLATERAL_TOKEN_OFFSET = 141
const SPOT_AMOUNT_OFFSET = 146
const SPOT_LOAN_SHARES_OFFSET = 154
const SPOT_LOAN_FUNDS_OFFSET = 162

const VAULT_MINT_OFFSET = 11
const VAULT_DEPOSITED_FUNDS_OFFSET = 43
const VAULT_DEPOSITED_SHARES_OFFSET = 51
const VAULT_BORROWED_FUNDS_OFFSET = 59
const VAULT_BORROWED_SHARES_OFFSET = 67
const VAULT_INTEREST_RATE_OFFSET = 83
const VAULT_ID_OFFSET = 127

const MARKET_MAKER_OFFSET = 11
const MARKET_POOL_OFFSET = 12
const MARKET_VAULT_A_OFFSET = 157
const MARKET_VAULT_B_OFFSET = 189

const MARKET_MAKER_ORCA = 0
const POOL_TOKEN_A = 0

interface LendingPositionRaw {
  address: string
  authority: string
  mint: string
  depositedFunds: bigint
  depositedShares: bigint
  vault: string
}

interface TunaLpPositionRaw {
  address: string
  authority: string
  pool: string
  mintA: string
  mintB: string
  positionMint: string
  liquidity: bigint
  tickLowerIndex: number
  tickUpperIndex: number
  loanSharesA: bigint
  loanSharesB: bigint
  loanFundsA: bigint
  loanFundsB: bigint
  leftoversA: bigint
  leftoversB: bigint
  compoundedYieldA: bigint
  compoundedYieldB: bigint
  marketMaker: number
}

interface TunaSpotPositionRaw {
  address: string
  authority: string
  pool: string
  mintA: string
  mintB: string
  marketMaker: number
  positionToken: number
  collateralToken: number
  amount: bigint
  loanShares: bigint
  loanFunds: bigint
}

interface VaultRaw {
  address: string
  mint: string
  depositedFunds: bigint
  depositedShares: bigint
  borrowedFunds: bigint
  borrowedShares: bigint
  interestRate: bigint
  id: number
}

interface MarketRaw {
  address: string
  marketMaker: number
  pool: string
  vaultA: string
  vaultB: string
}

export const PROGRAM_IDS = [TUNA_PROGRAM_ID] as const

function accountDiscriminator(
  idl: { accounts?: Array<{ name: string; discriminator?: number[] }> },
  accountName: string,
): Uint8Array {
  const discriminator = idl.accounts?.find(
    (account) => account.name === accountName,
  )?.discriminator

  if (!discriminator) {
    throw new Error(`Missing discriminator for account "${accountName}"`)
  }

  return Uint8Array.from(discriminator)
}

function discriminatorBase64(discriminator: Uint8Array): string {
  return Buffer.from(discriminator).toString('base64')
}

function hasDiscriminator(data: Uint8Array, discriminatorB64: string): boolean {
  if (data.length < 8) return false
  return (
    Buffer.from(data.subarray(0, 8)).toString('base64') === discriminatorB64
  )
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 32) return null
  return new PublicKey(buffer.subarray(offset, offset + 32)).toBase58()
}

function readU8(data: Uint8Array, offset: number): number | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 1) return null
  return buffer.readUInt8(offset)
}

function readU32LE(data: Uint8Array, offset: number): number | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 4) return null
  return buffer.readUInt32LE(offset)
}

function readI32LE(data: Uint8Array, offset: number): number | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 4) return null
  return buffer.readInt32LE(offset)
}

function readU64LE(data: Uint8Array, offset: number): bigint | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 8) return null
  return buffer.readBigUInt64LE(offset)
}

function readU128LE(data: Uint8Array, offset: number): bigint | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 16) return null

  let result = 0n
  for (let index = 0; index < 16; index++) {
    result |= BigInt(buffer[offset + index] ?? 0) << (BigInt(index) * 8n)
  }
  return result
}

function readMintDecimals(data: Uint8Array): number | null {
  const buffer = Buffer.from(data)
  if (buffer.length <= MINT_DECIMALS_OFFSET) return null
  return buffer.readUInt8(MINT_DECIMALS_OFFSET)
}

function parseLendingPosition(
  address: string,
  data: Uint8Array,
): LendingPositionRaw | null {
  const authority = readPubkey(data, LENDING_AUTHORITY_OFFSET)
  const mint = readPubkey(data, LENDING_MINT_OFFSET)
  const depositedFunds = readU64LE(data, LENDING_DEPOSITED_FUNDS_OFFSET)
  const depositedShares = readU64LE(data, LENDING_DEPOSITED_SHARES_OFFSET)
  const vault = readPubkey(data, LENDING_VAULT_OFFSET)

  if (
    !authority ||
    !mint ||
    depositedFunds === null ||
    depositedShares === null ||
    !vault
  ) {
    return null
  }

  return {
    address,
    authority,
    mint,
    depositedFunds,
    depositedShares,
    vault,
  }
}

function parseTunaLpPosition(
  address: string,
  data: Uint8Array,
): TunaLpPositionRaw | null {
  const authority = readPubkey(data, LP_AUTHORITY_OFFSET)
  const pool = readPubkey(data, LP_POOL_OFFSET)
  const mintA = readPubkey(data, LP_MINT_A_OFFSET)
  const mintB = readPubkey(data, LP_MINT_B_OFFSET)
  const positionMint = readPubkey(data, LP_POSITION_MINT_OFFSET)
  const liquidity = readU128LE(data, LP_LIQUIDITY_OFFSET)
  const tickLowerIndex = readI32LE(data, LP_TICK_LOWER_INDEX_OFFSET)
  const tickUpperIndex = readI32LE(data, LP_TICK_UPPER_INDEX_OFFSET)
  const loanSharesA = readU64LE(data, LP_LOAN_SHARES_A_OFFSET)
  const loanSharesB = readU64LE(data, LP_LOAN_SHARES_B_OFFSET)
  const loanFundsA = readU64LE(data, LP_LOAN_FUNDS_A_OFFSET)
  const loanFundsB = readU64LE(data, LP_LOAN_FUNDS_B_OFFSET)
  const leftoversA = readU64LE(data, LP_LEFTOVERS_A_OFFSET)
  const leftoversB = readU64LE(data, LP_LEFTOVERS_B_OFFSET)
  const compoundedYieldA = readU64LE(data, LP_COMPOUNDED_YIELD_A_OFFSET)
  const compoundedYieldB = readU64LE(data, LP_COMPOUNDED_YIELD_B_OFFSET)
  const marketMaker = readU8(data, LP_MARKET_MAKER_OFFSET)

  if (
    !authority ||
    !pool ||
    !mintA ||
    !mintB ||
    !positionMint ||
    liquidity === null ||
    tickLowerIndex === null ||
    tickUpperIndex === null ||
    loanSharesA === null ||
    loanSharesB === null ||
    loanFundsA === null ||
    loanFundsB === null ||
    leftoversA === null ||
    leftoversB === null ||
    compoundedYieldA === null ||
    compoundedYieldB === null ||
    marketMaker === null
  ) {
    return null
  }

  return {
    address,
    authority,
    pool,
    mintA,
    mintB,
    positionMint,
    liquidity,
    tickLowerIndex,
    tickUpperIndex,
    loanSharesA,
    loanSharesB,
    loanFundsA,
    loanFundsB,
    leftoversA,
    leftoversB,
    compoundedYieldA,
    compoundedYieldB,
    marketMaker,
  }
}

function toAccountInfo(
  account: MaybeSolanaAccount | undefined,
): import('@solana/web3.js').AccountInfo<Buffer> | null {
  if (!account?.exists) return null

  return {
    data: Buffer.from(account.data),
    owner: new PublicKey(account.programAddress),
    lamports: Number(account.lamports),
    executable: false,
    rentEpoch: 0,
  }
}

function parseWhirlpool(
  address: string,
  account: MaybeSolanaAccount | undefined,
): WhirlpoolData | null {
  return ParsableWhirlpool.parse(new PublicKey(address), toAccountInfo(account))
}

function parseTunaSpotPosition(
  address: string,
  data: Uint8Array,
): TunaSpotPositionRaw | null {
  const authority = readPubkey(data, SPOT_AUTHORITY_OFFSET)
  const pool = readPubkey(data, SPOT_POOL_OFFSET)
  const mintA = readPubkey(data, SPOT_MINT_A_OFFSET)
  const mintB = readPubkey(data, SPOT_MINT_B_OFFSET)
  const marketMaker = readU8(data, SPOT_MARKET_MAKER_OFFSET)
  const positionToken = readU8(data, SPOT_POSITION_TOKEN_OFFSET)
  const collateralToken = readU8(data, SPOT_COLLATERAL_TOKEN_OFFSET)
  const amount = readU64LE(data, SPOT_AMOUNT_OFFSET)
  const loanShares = readU64LE(data, SPOT_LOAN_SHARES_OFFSET)
  const loanFunds = readU64LE(data, SPOT_LOAN_FUNDS_OFFSET)

  if (
    !authority ||
    !pool ||
    !mintA ||
    !mintB ||
    marketMaker === null ||
    positionToken === null ||
    collateralToken === null ||
    amount === null ||
    loanShares === null ||
    loanFunds === null
  ) {
    return null
  }

  return {
    address,
    authority,
    pool,
    mintA,
    mintB,
    marketMaker,
    positionToken,
    collateralToken,
    amount,
    loanShares,
    loanFunds,
  }
}

function parseVault(address: string, data: Uint8Array): VaultRaw | null {
  const mint = readPubkey(data, VAULT_MINT_OFFSET)
  const depositedFunds = readU64LE(data, VAULT_DEPOSITED_FUNDS_OFFSET)
  const depositedShares = readU64LE(data, VAULT_DEPOSITED_SHARES_OFFSET)
  const borrowedFunds = readU64LE(data, VAULT_BORROWED_FUNDS_OFFSET)
  const borrowedShares = readU64LE(data, VAULT_BORROWED_SHARES_OFFSET)
  const interestRate = readU64LE(data, VAULT_INTEREST_RATE_OFFSET)
  const id = readU32LE(data, VAULT_ID_OFFSET)

  if (
    !mint ||
    depositedFunds === null ||
    depositedShares === null ||
    borrowedFunds === null ||
    borrowedShares === null ||
    interestRate === null ||
    id === null
  ) {
    return null
  }

  return {
    address,
    mint,
    depositedFunds,
    depositedShares,
    borrowedFunds,
    borrowedShares,
    interestRate,
    id,
  }
}

function parseMarket(address: string, data: Uint8Array): MarketRaw | null {
  const marketMaker = readU8(data, MARKET_MAKER_OFFSET)
  const pool = readPubkey(data, MARKET_POOL_OFFSET)
  const vaultA = readPubkey(data, MARKET_VAULT_A_OFFSET)
  const vaultB = readPubkey(data, MARKET_VAULT_B_OFFSET)

  if (marketMaker === null || !pool || !vaultA || !vaultB) {
    return null
  }

  return {
    address,
    marketMaker,
    pool,
    vaultA,
    vaultB,
  }
}

function sharesToFunds(
  shares: bigint,
  totalFunds: bigint,
  totalShares: bigint,
): bigint {
  if (shares === 0n) return 0n
  if (totalShares > 0n) return (shares * totalFunds) / totalShares
  return shares
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
  const fractionalPart = (remainder * scale) / absDen
  const trimmed = fractionalPart
    .toString()
    .padStart(digits, '0')
    .replace(/0+$/, '')

  if (trimmed.length === 0) {
    return `${negative ? '-' : ''}${integerPart}`
  }

  return `${negative ? '-' : ''}${integerPart}.${trimmed}`
}

function annualizeRate(interestRate: bigint): string {
  return divideToDecimalString(
    interestRate * SECONDS_PER_YEAR,
    FIXED_POINT_SCALE,
  )
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
  const numeric = values
    .filter((value): value is string => value !== undefined)
    .map(Number)

  if (numeric.length === 0) return undefined

  const total = numeric.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total)) return undefined
  return total.toString()
}

function marketPoolKey(pool: string, marketMaker: number): string {
  return `${pool}|${marketMaker}`
}

function resolveMintDecimals(
  mint: string,
  mintAccounts: AccountsMap,
  tokens: SolanaPlugins['tokens'],
): number {
  const account = mintAccounts[mint]
  const parsed = account?.exists ? readMintDecimals(account.data) : null
  const tokenDecimals = tokens.get(mint)?.decimals
  return parsed ?? tokenDecimals ?? 0
}

export const defitunaIntegration: SolanaIntegration = {
  platformId: 'defituna',

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

    const phase0Accounts = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: TUNA_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: LENDING_AUTHORITY_OFFSET,
              bytes: address,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: TUNA_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: MARKET_DISCRIMINATOR_B64,
              encoding: 'base64' as const,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: TUNA_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: VAULT_DISCRIMINATOR_B64,
              encoding: 'base64' as const,
            },
          },
        ],
      },
    ]

    const lendingAccounts: LendingPositionRaw[] = []
    const lpAccounts: TunaLpPositionRaw[] = []
    const spotAccounts: TunaSpotPositionRaw[] = []
    const vaultByAddress = new Map<string, VaultRaw>()
    const vaultByMint = new Map<string, VaultRaw>()
    const marketByPoolAndMaker = new Map<string, MarketRaw>()

    for (const account of Object.values(phase0Accounts)) {
      if (!account.exists || account.programAddress !== TUNA_PROGRAM_ID)
        continue

      if (hasDiscriminator(account.data, VAULT_DISCRIMINATOR_B64)) {
        const parsed = parseVault(account.address, account.data)
        if (!parsed) continue

        vaultByAddress.set(parsed.address, parsed)

        const existing = vaultByMint.get(parsed.mint)
        if (!existing || (existing.id !== 0 && parsed.id === 0)) {
          vaultByMint.set(parsed.mint, parsed)
        }
        continue
      }

      if (hasDiscriminator(account.data, MARKET_DISCRIMINATOR_B64)) {
        const parsed = parseMarket(account.address, account.data)
        if (!parsed) continue

        marketByPoolAndMaker.set(
          marketPoolKey(parsed.pool, parsed.marketMaker),
          parsed,
        )
        continue
      }

      if (hasDiscriminator(account.data, LENDING_POSITION_DISCRIMINATOR_B64)) {
        const parsed = parseLendingPosition(account.address, account.data)
        if (parsed && parsed.authority === address) {
          lendingAccounts.push(parsed)
        }
        continue
      }

      if (hasDiscriminator(account.data, TUNA_LP_POSITION_DISCRIMINATOR_B64)) {
        const parsed = parseTunaLpPosition(account.address, account.data)
        if (parsed && parsed.authority === address) {
          lpAccounts.push(parsed)
        }
        continue
      }

      if (
        hasDiscriminator(account.data, TUNA_SPOT_POSITION_DISCRIMINATOR_B64)
      ) {
        const parsed = parseTunaSpotPosition(account.address, account.data)
        if (parsed && parsed.authority === address) {
          spotAccounts.push(parsed)
        }
      }
    }

    if (
      lendingAccounts.length === 0 &&
      lpAccounts.length === 0 &&
      spotAccounts.length === 0
    ) {
      return []
    }

    const mintAddresses = new Set<string>()
    for (const lending of lendingAccounts) {
      mintAddresses.add(lending.mint)
    }
    for (const lp of lpAccounts) {
      mintAddresses.add(lp.mintA)
      mintAddresses.add(lp.mintB)
    }
    for (const spot of spotAccounts) {
      mintAddresses.add(spot.mintA)
      mintAddresses.add(spot.mintB)
    }

    const mintAccounts = mintAddresses.size > 0 ? yield [...mintAddresses] : {}
    const orcaPoolAddresses = [
      ...new Set(
        lpAccounts
          .filter((position) => position.marketMaker === MARKET_MAKER_ORCA)
          .map((position) => position.pool),
      ),
    ]
    const orcaPoolAccounts =
      orcaPoolAddresses.length > 0 ? yield orcaPoolAddresses : {}
    const whirlpoolByAddress = new Map<string, WhirlpoolData>()
    for (const poolAddress of orcaPoolAddresses) {
      const whirlpool = parseWhirlpool(
        poolAddress,
        orcaPoolAccounts[poolAddress],
      )
      if (whirlpool) whirlpoolByAddress.set(poolAddress, whirlpool)
    }

    const positions: UserDefiPosition[] = []

    for (const lending of lendingAccounts) {
      const tokenInfo = tokens.get(lending.mint)
      const decimals = resolveMintDecimals(lending.mint, mintAccounts, tokens)

      const explicitVault =
        lending.vault !== DEFAULT_PUBLIC_KEY
          ? vaultByAddress.get(lending.vault)
          : undefined
      const fallbackVault = vaultByMint.get(lending.mint)
      const resolvedVault = explicitVault ?? fallbackVault

      const currentAmount = resolvedVault
        ? sharesToFunds(
            lending.depositedShares,
            resolvedVault.depositedFunds,
            resolvedVault.depositedShares,
          )
        : lending.depositedFunds

      if (currentAmount <= 0n) continue

      const supplied: LendingSuppliedAsset = {
        amount: {
          token: lending.mint,
          amount: currentAmount.toString(),
          decimals: decimals.toString(),
        },
        ...(resolvedVault && {
          supplyRate: annualizeRate(resolvedVault.interestRate),
        }),
        ...(tokenInfo?.priceUsd !== undefined && {
          priceUsd: tokenInfo.priceUsd.toString(),
        }),
      }

      const usdValue = buildUsdValue(
        currentAmount,
        decimals,
        tokenInfo?.priceUsd,
      )
      if (usdValue !== undefined) {
        supplied.usdValue = usdValue
      }

      const position: LendingDefiPosition = {
        platformId: 'defituna',
        positionKind: 'lending',
        supplied: [supplied],
        ...(usdValue !== undefined && { usdValue }),
        meta: {
          defitunaLending: {
            account: lending.address,
            vault: resolvedVault?.address ?? lending.vault,
            mint: lending.mint,
            depositedFundsRaw: lending.depositedFunds.toString(),
            depositedSharesRaw: lending.depositedShares.toString(),
            amountSource: resolvedVault
              ? 'vault-share-conversion'
              : 'deposited-funds-fallback',
          },
        },
      }

      positions.push(position)
    }

    for (const lp of lpAccounts) {
      const market = marketByPoolAndMaker.get(
        marketPoolKey(lp.pool, lp.marketMaker),
      )
      const vaultA = market ? vaultByAddress.get(market.vaultA) : undefined
      const vaultB = market ? vaultByAddress.get(market.vaultB) : undefined

      const borrowedA = vaultA
        ? sharesToFunds(
            lp.loanSharesA,
            vaultA.borrowedFunds,
            vaultA.borrowedShares,
          )
        : lp.loanFundsA
      const borrowedB = vaultB
        ? sharesToFunds(
            lp.loanSharesB,
            vaultB.borrowedFunds,
            vaultB.borrowedShares,
          )
        : lp.loanFundsB

      const decimalsA = resolveMintDecimals(lp.mintA, mintAccounts, tokens)
      const decimalsB = resolveMintDecimals(lp.mintB, mintAccounts, tokens)
      const tokenA = tokens.get(lp.mintA)
      const tokenB = tokens.get(lp.mintB)
      const whirlpool =
        lp.marketMaker === MARKET_MAKER_ORCA
          ? whirlpoolByAddress.get(lp.pool)
          : undefined

      let principalA = 0n
      let principalB = 0n
      if (whirlpool) {
        try {
          const principal = PoolUtil.getTokenAmountsFromLiquidity(
            new BN(lp.liquidity.toString()),
            whirlpool.sqrtPrice,
            PriceMath.tickIndexToSqrtPriceX64(lp.tickLowerIndex),
            PriceMath.tickIndexToSqrtPriceX64(lp.tickUpperIndex),
            false,
          )
          principalA = BigInt(principal.tokenA.toString())
          principalB = BigInt(principal.tokenB.toString())
        } catch {
          // Fall back to debt + leftovers if whirlpool quote fails.
        }
      }
      const hasWhirlpoolPrincipal = whirlpool !== undefined
      const suppliedA = hasWhirlpoolPrincipal ? principalA : borrowedA
      const suppliedB = hasWhirlpoolPrincipal ? principalB : borrowedB
      const hasBorrowedExposure = borrowedA > 0n || borrowedB > 0n
      const includeZeroTokenRows = hasBorrowedExposure

      const poolTokens: PositionValue[] = []
      if (suppliedA > 0n || includeZeroTokenRows) {
        poolTokens.push(
          buildPositionValue(lp.mintA, suppliedA, decimalsA, tokenA?.priceUsd),
        )
      }
      if (suppliedB > 0n || includeZeroTokenRows) {
        poolTokens.push(
          buildPositionValue(lp.mintB, suppliedB, decimalsB, tokenB?.priceUsd),
        )
      }
      if (hasBorrowedExposure && (lp.leftoversA > 0n || includeZeroTokenRows)) {
        poolTokens.push(
          buildPositionValue(
            lp.mintA,
            lp.leftoversA,
            decimalsA,
            tokenA?.priceUsd,
          ),
        )
      }
      if (hasBorrowedExposure && (lp.leftoversB > 0n || includeZeroTokenRows)) {
        poolTokens.push(
          buildPositionValue(
            lp.mintB,
            lp.leftoversB,
            decimalsB,
            tokenB?.priceUsd,
          ),
        )
      }

      const rewards: PositionValue[] = []
      if (!hasBorrowedExposure && lp.leftoversA > 0n) {
        rewards.push(
          buildPositionValue(
            lp.mintA,
            lp.leftoversA,
            decimalsA,
            tokenA?.priceUsd,
          ),
        )
      }
      if (!hasBorrowedExposure && lp.leftoversB > 0n) {
        rewards.push(
          buildPositionValue(
            lp.mintB,
            lp.leftoversB,
            decimalsB,
            tokenB?.priceUsd,
          ),
        )
      }
      if (lp.compoundedYieldA > 0n) {
        rewards.push(
          buildPositionValue(
            lp.mintA,
            lp.compoundedYieldA,
            decimalsA,
            tokenA?.priceUsd,
          ),
        )
      }
      if (lp.compoundedYieldB > 0n) {
        rewards.push(
          buildPositionValue(
            lp.mintB,
            lp.compoundedYieldB,
            decimalsB,
            tokenB?.priceUsd,
          ),
        )
      }

      if (
        poolTokens.length === 0 &&
        rewards.length === 0 &&
        borrowedA === 0n &&
        borrowedB === 0n &&
        lp.liquidity === 0n
      ) {
        continue
      }

      const liquidityPosition: ConstantProductLiquidityDefiPosition = {
        platformId: 'defituna',
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        poolAddress: lp.pool,
        poolTokens,
        lpTokenAmount: lp.liquidity.toString(),
        ...(rewards.length > 0 && { rewards }),
        meta: {
          defitunaLp: {
            account: lp.address,
            marketMaker:
              lp.marketMaker === MARKET_MAKER_ORCA ? 'orca' : 'fusion',
            positionMint: lp.positionMint,
            marketAddress: market?.address,
            tickLowerIndex: lp.tickLowerIndex,
            tickUpperIndex: lp.tickUpperIndex,
            loanSharesARaw: lp.loanSharesA.toString(),
            loanSharesBRaw: lp.loanSharesB.toString(),
            loanFundsARaw: lp.loanFundsA.toString(),
            loanFundsBRaw: lp.loanFundsB.toString(),
            leftoversARaw: lp.leftoversA.toString(),
            leftoversBRaw: lp.leftoversB.toString(),
            compoundedYieldARaw: lp.compoundedYieldA.toString(),
            compoundedYieldBRaw: lp.compoundedYieldB.toString(),
            borrowed: {
              tokenA: borrowedA.toString(),
              tokenB: borrowedB.toString(),
            },
            supplied: {
              tokenA: (suppliedA + lp.leftoversA).toString(),
              tokenB: (suppliedB + lp.leftoversB).toString(),
            },
            valuationMode: whirlpool
              ? 'orca-principal-minus-borrowed'
              : 'partial-exposure-fallback',
          },
        },
      }

      const usdValue = sumUsdValues(
        [...poolTokens, ...rewards].map((tokenValue) => tokenValue.usdValue),
      )
      if (usdValue !== undefined) {
        liquidityPosition.usdValue = usdValue
      }

      positions.push(liquidityPosition)
    }

    for (const spot of spotAccounts) {
      const market = marketByPoolAndMaker.get(
        marketPoolKey(spot.pool, spot.marketMaker),
      )
      const side = spot.positionToken === POOL_TOKEN_A ? 'long' : 'short'
      const sizeMint = side === 'long' ? spot.mintA : spot.mintB
      const borrowedMint = side === 'long' ? spot.mintB : spot.mintA

      const borrowedVaultAddress =
        side === 'long' ? market?.vaultB : market?.vaultA
      const borrowedVault = borrowedVaultAddress
        ? vaultByAddress.get(borrowedVaultAddress)
        : undefined
      const borrowedAmount = borrowedVault
        ? sharesToFunds(
            spot.loanShares,
            borrowedVault.borrowedFunds,
            borrowedVault.borrowedShares,
          )
        : spot.loanFunds

      if (spot.amount === 0n && borrowedAmount === 0n) continue

      const sizeDecimals = resolveMintDecimals(sizeMint, mintAccounts, tokens)
      const sizeToken = tokens.get(sizeMint)
      const sizeValue = buildPositionValue(
        sizeMint,
        spot.amount,
        sizeDecimals,
        sizeToken?.priceUsd,
      )

      const borrowedDecimals = resolveMintDecimals(
        borrowedMint,
        mintAccounts,
        tokens,
      )
      const borrowedToken = tokens.get(borrowedMint)
      const borrowedValue = buildPositionValue(
        borrowedMint,
        borrowedAmount,
        borrowedDecimals,
        borrowedToken?.priceUsd,
      )

      const position: TradingDefiPosition = {
        platformId: 'defituna',
        positionKind: 'trading',
        marketType: 'spot',
        marginEnabled: true,
        positions: [
          {
            side,
            size: sizeValue,
            ...(sizeValue.usdValue !== undefined && {
              notionalUsd: sizeValue.usdValue,
            }),
          },
        ],
        ...(sizeValue.usdValue !== undefined && {
          usdValue: sizeValue.usdValue,
        }),
        meta: {
          defitunaSpot: {
            account: spot.address,
            marketMaker:
              spot.marketMaker === MARKET_MAKER_ORCA ? 'orca' : 'fusion',
            pool: spot.pool,
            marketAddress: market?.address,
            positionToken: spot.positionToken,
            collateralToken: spot.collateralToken,
            amountRaw: spot.amount.toString(),
            loanSharesRaw: spot.loanShares.toString(),
            loanFundsRaw: spot.loanFunds.toString(),
            borrowed: {
              token: borrowedMint,
              amount: borrowedValue.amount.amount,
              decimals: borrowedValue.amount.decimals,
              ...(borrowedValue.usdValue !== undefined && {
                usdValue: borrowedValue.usdValue,
              }),
            },
            valuationMode: 'partial-exposure',
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
      programId: TUNA_PROGRAM_ID,
      discriminator: LENDING_POSITION_DISCRIMINATOR,
      ownerOffset: LENDING_AUTHORITY_OFFSET,
    },
    {
      programId: TUNA_PROGRAM_ID,
      discriminator: TUNA_LP_POSITION_DISCRIMINATOR,
      ownerOffset: LP_AUTHORITY_OFFSET,
    },
    {
      programId: TUNA_PROGRAM_ID,
      discriminator: TUNA_SPOT_POSITION_DISCRIMINATOR,
      ownerOffset: SPOT_AUTHORITY_OFFSET,
    },
  ],
}

export default defitunaIntegration
