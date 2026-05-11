import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const CLEND_PROGRAM_ID = 'C73nDAFn23RYwiFa6vtHshSbcg8x6BLYjw3bERJ3vHxf'
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'
const CLEND_ACCOUNT_DISCRIMINATOR = accountDiscriminator('ClendAccount')
const BANK_DISCRIMINATOR = accountDiscriminator('Bank')
const CLEND_ACCOUNT_DISCRIMINATOR_B64 =
  CLEND_ACCOUNT_DISCRIMINATOR.toString('base64')
const CLEND_ACCOUNT_AUTHORITY_OFFSET = 40
const CLEND_ACCOUNT_BALANCES_OFFSET = 72
const CLEND_ACCOUNT_BALANCE_SIZE = 104
const CLEND_ACCOUNT_BALANCE_COUNT = 16
const I80F48_FRACTION_BITS = 48n
const I80F48_SCALE = 1n << I80F48_FRACTION_BITS
const I80F48_SCALE_SQUARED = I80F48_SCALE * I80F48_SCALE
const BANK_MINT_OFFSET = 8
const BANK_MINT_DECIMALS_OFFSET = 40
const BANK_GROUP_OFFSET = 41
const BANK_ASSET_SHARE_VALUE_OFFSET = 80
const BANK_LIABILITY_SHARE_VALUE_OFFSET = 96
const BANK_CONFIG_OFFSET = 296
const BANK_CONFIG_ASSET_WEIGHT_MAINT_OFFSET = BANK_CONFIG_OFFSET + 16
const BANK_CONFIG_LIABILITY_WEIGHT_MAINT_OFFSET = BANK_CONFIG_OFFSET + 48

export const PROGRAM_IDS = [CLEND_PROGRAM_ID] as const

interface ClendBalanceRaw {
  bankPk: string
  assetShares: bigint
  liabilityShares: bigint
  emissionsOutstanding: bigint
}

interface ClendAccountRaw {
  group: string
  authority: string
  balances: ClendBalanceRaw[]
}

interface BankRaw {
  mint: string
  mintDecimals: number
  group: string
  assetShareValue: bigint
  liabilityShareValue: bigint
  assetWeightMaint: bigint
  liabilityWeightMaint: bigint
}

function accountDiscriminator(accountName: string): Buffer {
  return createHash('sha256')
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8)
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function readSignedI128LE(buf: Buffer, offset: number): bigint {
  let value = 0n

  for (let idx = 0; idx < 16; idx++) {
    value |= BigInt(buf[offset + idx] ?? 0) << (BigInt(idx) * 8n)
  }

  if ((buf[offset + 15] ?? 0) & 0x80) {
    value -= 1n << 128n
  }

  return value
}

function wrappedI80F48ToDecimalString(value: bigint, digits = 6): string {
  return divideToDecimalString(value, I80F48_SCALE, digits)
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

function mulDivTrunc(
  numeratorA: bigint,
  numeratorB: bigint,
  denominator: bigint,
): bigint {
  if (denominator === 0n) return 0n

  const negative = numeratorA < 0n !== numeratorB < 0n
  const absA = numeratorA < 0n ? -numeratorA : numeratorA
  const absB = numeratorB < 0n ? -numeratorB : numeratorB
  const quotient = (absA * absB) / denominator

  return negative ? -quotient : quotient
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

function sumPositionUsdValue(
  supplied: LendingSuppliedAsset[],
  borrowed: LendingBorrowedAsset[],
): string | undefined {
  const suppliedValue = supplied.reduce(
    (sum, asset) => sum + Number(asset.usdValue ?? 0),
    0,
  )
  const borrowedValue = borrowed.reduce(
    (sum, asset) => sum + Number(asset.usdValue ?? 0),
    0,
  )

  if (!Number.isFinite(suppliedValue) || !Number.isFinite(borrowedValue)) {
    return undefined
  }

  if (
    supplied.every((asset) => asset.usdValue === undefined) &&
    borrowed.every((asset) => asset.usdValue === undefined)
  ) {
    return undefined
  }

  return (suppliedValue - borrowedValue).toString()
}

function parseClendAccount(
  data: Uint8Array,
  expectedAuthority: string,
): ClendAccountRaw | null {
  const buf = Buffer.from(data)

  if (buf.length < CLEND_ACCOUNT_BALANCES_OFFSET) return null
  if (!buf.subarray(0, 8).equals(CLEND_ACCOUNT_DISCRIMINATOR)) return null

  const authority = readPubkey(buf, CLEND_ACCOUNT_AUTHORITY_OFFSET)
  if (authority !== expectedAuthority) return null

  const balances: ClendBalanceRaw[] = []

  for (let index = 0; index < CLEND_ACCOUNT_BALANCE_COUNT; index++) {
    const offset =
      CLEND_ACCOUNT_BALANCES_OFFSET + index * CLEND_ACCOUNT_BALANCE_SIZE
    if (offset + CLEND_ACCOUNT_BALANCE_SIZE > buf.length) break
    if (buf[offset] !== 1) continue

    const assetShares = readSignedI128LE(buf, offset + 40)
    const liabilityShares = readSignedI128LE(buf, offset + 56)
    const emissionsOutstanding = readSignedI128LE(buf, offset + 72)

    if (
      assetShares <= 0n &&
      liabilityShares <= 0n &&
      emissionsOutstanding <= 0n
    ) {
      continue
    }

    balances.push({
      bankPk: readPubkey(buf, offset + 1),
      assetShares,
      liabilityShares,
      emissionsOutstanding,
    })
  }

  if (balances.length === 0) return null

  return {
    group: readPubkey(buf, 8),
    authority,
    balances,
  }
}

function parseBank(data: Uint8Array): BankRaw | null {
  const buf = Buffer.from(data)

  if (buf.length < BANK_CONFIG_LIABILITY_WEIGHT_MAINT_OFFSET + 16) return null
  if (!buf.subarray(0, 8).equals(BANK_DISCRIMINATOR)) return null

  return {
    mint: readPubkey(buf, BANK_MINT_OFFSET),
    mintDecimals: buf[BANK_MINT_DECIMALS_OFFSET] ?? 0,
    group: readPubkey(buf, BANK_GROUP_OFFSET),
    assetShareValue: readSignedI128LE(buf, BANK_ASSET_SHARE_VALUE_OFFSET),
    liabilityShareValue: readSignedI128LE(
      buf,
      BANK_LIABILITY_SHARE_VALUE_OFFSET,
    ),
    assetWeightMaint: readSignedI128LE(
      buf,
      BANK_CONFIG_ASSET_WEIGHT_MAINT_OFFSET,
    ),
    liabilityWeightMaint: readSignedI128LE(
      buf,
      BANK_CONFIG_LIABILITY_WEIGHT_MAINT_OFFSET,
    ),
  }
}

function suppliedAmountRaw(balance: ClendBalanceRaw, bank: BankRaw): bigint {
  return mulDivTrunc(
    balance.assetShares,
    bank.assetShareValue,
    I80F48_SCALE_SQUARED,
  )
}

function borrowedAmountRaw(balance: ClendBalanceRaw, bank: BankRaw): bigint {
  return mulDivTrunc(
    balance.liabilityShares,
    bank.liabilityShareValue,
    I80F48_SCALE_SQUARED,
  )
}

function buildSuppliedAsset(
  balance: ClendBalanceRaw,
  bank: BankRaw,
  tokens: SolanaPlugins['tokens'],
): LendingSuppliedAsset | null {
  const amountRaw = suppliedAmountRaw(balance, bank)
  if (amountRaw <= 0n) return null

  const token = tokens.get(bank.mint)
  const usdValue = buildUsdValue(amountRaw, bank.mintDecimals, token?.priceUsd)

  return {
    amount: {
      token: bank.mint,
      amount: amountRaw.toString(),
      decimals: bank.mintDecimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
    ...(bank.assetWeightMaint > 0n && {
      collateralFactor: wrappedI80F48ToDecimalString(bank.assetWeightMaint),
    }),
  }
}

function buildBorrowedAsset(
  balance: ClendBalanceRaw,
  bank: BankRaw,
  tokens: SolanaPlugins['tokens'],
): LendingBorrowedAsset | null {
  const amountRaw = borrowedAmountRaw(balance, bank)
  if (amountRaw <= 0n) return null

  const token = tokens.get(bank.mint)
  const usdValue = buildUsdValue(amountRaw, bank.mintDecimals, token?.priceUsd)

  return {
    amount: {
      token: bank.mint,
      amount: amountRaw.toString(),
      decimals: bank.mintDecimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
    ...(bank.liabilityWeightMaint > 0n && {
      maintenanceRatio: wrappedI80F48ToDecimalString(bank.liabilityWeightMaint),
    }),
  }
}

export const carrotIntegration: SolanaIntegration = {
  platformId: 'carrot',

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

    const phase0Map = yield {
      kind: 'getProgramAccounts' as const,
      programId: CLEND_PROGRAM_ID,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: CLEND_ACCOUNT_DISCRIMINATOR_B64,
            encoding: 'base64',
          },
        },
        { memcmp: { offset: CLEND_ACCOUNT_AUTHORITY_OFFSET, bytes: address } },
      ],
    }

    const accounts = Object.values(phase0Map)
      .filter((account) => account.exists)
      .map((account) => ({
        address: account.address,
        decoded: parseClendAccount(account.data, address),
      }))
      .filter(
        (
          entry,
        ): entry is {
          address: string
          decoded: ClendAccountRaw
        } => entry.decoded !== null,
      )

    if (accounts.length === 0) return []

    const bankAddresses = [
      ...new Set(
        accounts.flatMap((account) =>
          account.decoded.balances.map((balance) => balance.bankPk),
        ),
      ),
    ]

    const bankAccounts = bankAddresses.length > 0 ? yield bankAddresses : {}
    const banksByAddress = new Map<string, BankRaw>()

    for (const bankAddress of bankAddresses) {
      const account = bankAccounts[bankAddress]
      if (!account?.exists) continue

      const bank = parseBank(account.data)
      if (!bank) continue
      banksByAddress.set(bankAddress, bank)
    }

    const positions: UserDefiPosition[] = []

    for (const account of accounts) {
      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []

      for (const balance of account.decoded.balances) {
        const bank = banksByAddress.get(balance.bankPk)
        if (!bank || bank.group !== account.decoded.group) continue
        if (bank.mint === DEFAULT_PUBLIC_KEY) continue

        const suppliedAsset = buildSuppliedAsset(balance, bank, tokens)
        if (suppliedAsset) supplied.push(suppliedAsset)

        const borrowedAsset = buildBorrowedAsset(balance, bank, tokens)
        if (borrowedAsset) borrowed.push(borrowedAsset)
      }

      if (supplied.length === 0 && borrowed.length === 0) continue

      const position: LendingDefiPosition = {
        platformId: 'carrot',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        meta: {
          clend: {
            account: account.address,
            group: account.decoded.group,
          },
        },
      }

      const usdValue = sumPositionUsdValue(supplied, borrowed)
      if (usdValue !== undefined) {
        position.usdValue = usdValue
      }

      positions.push(position)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: CLEND_PROGRAM_ID,
      discriminator: CLEND_ACCOUNT_DISCRIMINATOR,
      ownerOffset: CLEND_ACCOUNT_AUTHORITY_OFFSET,
    },
  ],
}

export default carrotIntegration
