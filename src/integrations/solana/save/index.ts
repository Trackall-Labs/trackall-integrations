import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
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
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'

const SAVE_PROGRAM_ID = 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo'
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'
const TOKEN_PROGRAM_ID_STR = TOKEN_PROGRAM_ID.toBase58()
const TOKEN_2022_PROGRAM_ID_STR = TOKEN_2022_PROGRAM_ID.toBase58()

const OBLIGATION_MARKET_OFFSET = 10
const OBLIGATION_OWNER_OFFSET = 42
const OBLIGATION_DEPOSITS_LEN_OFFSET = 202
const OBLIGATION_BORROWS_LEN_OFFSET = 203
const OBLIGATION_ITEMS_OFFSET = 204
const OBLIGATION_DEPOSIT_SIZE = 88
const OBLIGATION_BORROW_SIZE = 112
const OBLIGATION_DEPOSIT_RESERVE_OFFSET = 0
const OBLIGATION_DEPOSIT_AMOUNT_OFFSET = 32
const OBLIGATION_BORROW_RESERVE_OFFSET = 0
const OBLIGATION_BORROW_CUMULATIVE_BORROW_RATE_WADS_OFFSET = 32
const OBLIGATION_BORROW_BORROWED_AMOUNT_WADS_OFFSET = 48

const RESERVE_ACCOUNT_SIZE = 619
const RESERVE_LIQUIDITY_MINT_OFFSET = 42
const RESERVE_LIQUIDITY_DECIMALS_OFFSET = 74
const RESERVE_LIQUIDITY_AVAILABLE_AMOUNT_OFFSET = 171
const RESERVE_LIQUIDITY_BORROWED_AMOUNT_WADS_OFFSET = 179
const RESERVE_LIQUIDITY_CUMULATIVE_BORROW_RATE_WADS_OFFSET = 195
const RESERVE_COLLATERAL_MINT_OFFSET = 227
const RESERVE_COLLATERAL_MINT_TOTAL_SUPPLY_OFFSET = 259
const RESERVE_ACCUMULATED_PROTOCOL_FEES_WADS_OFFSET = 373

const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const TOKEN_ACCOUNT_MIN_SIZE = TOKEN_ACCOUNT_AMOUNT_OFFSET + 8

const WAD = 10n ** 18n

interface ParsedObligationDeposit {
  reserve: string
  depositedAmount: bigint
}

interface ParsedObligationBorrow {
  reserve: string
  cumulativeBorrowRateWads: bigint
  borrowedAmountWads: bigint
}

interface ParsedObligation {
  address: string
  lendingMarket: string
  deposits: ParsedObligationDeposit[]
  borrows: ParsedObligationBorrow[]
}

interface ParsedReserve {
  address: string
  lendingMarket: string
  liquidityMint: string
  liquidityDecimals: number
  liquidityAvailableAmount: bigint
  liquidityBorrowedAmountWads: bigint
  liquidityCumulativeBorrowRateWads: bigint
  collateralMint: string
  collateralMintTotalSupply: bigint
  accumulatedProtocolFeesWads: bigint
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  SAVE_PROGRAM_ID,
  TOKEN_PROGRAM_ID_STR,
  TOKEN_2022_PROGRAM_ID_STR,
] as const

function readPubkey(data: Uint8Array, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58()
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readU128LE(data: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let index = 0; index < 16; index++) {
    value |= BigInt(data[offset + index] ?? 0) << (BigInt(index) * 8n)
  }
  return value
}

function parseObligation(
  address: string,
  data: Uint8Array,
): ParsedObligation | null {
  if (data.length < OBLIGATION_ITEMS_OFFSET) return null

  const depositsLen = data[OBLIGATION_DEPOSITS_LEN_OFFSET] ?? 0
  const borrowsLen = data[OBLIGATION_BORROWS_LEN_OFFSET] ?? 0
  const depositsSectionEnd =
    OBLIGATION_ITEMS_OFFSET + depositsLen * OBLIGATION_DEPOSIT_SIZE
  const borrowsSectionEnd =
    depositsSectionEnd + borrowsLen * OBLIGATION_BORROW_SIZE

  if (borrowsSectionEnd > data.length) return null

  let cursor = OBLIGATION_ITEMS_OFFSET

  const deposits: ParsedObligationDeposit[] = []
  for (let index = 0; index < depositsLen; index++) {
    deposits.push({
      reserve: readPubkey(data, cursor + OBLIGATION_DEPOSIT_RESERVE_OFFSET),
      depositedAmount: readU64LE(
        data,
        cursor + OBLIGATION_DEPOSIT_AMOUNT_OFFSET,
      ),
    })
    cursor += OBLIGATION_DEPOSIT_SIZE
  }

  const borrows: ParsedObligationBorrow[] = []
  for (let index = 0; index < borrowsLen; index++) {
    borrows.push({
      reserve: readPubkey(data, cursor + OBLIGATION_BORROW_RESERVE_OFFSET),
      cumulativeBorrowRateWads: readU128LE(
        data,
        cursor + OBLIGATION_BORROW_CUMULATIVE_BORROW_RATE_WADS_OFFSET,
      ),
      borrowedAmountWads: readU128LE(
        data,
        cursor + OBLIGATION_BORROW_BORROWED_AMOUNT_WADS_OFFSET,
      ),
    })
    cursor += OBLIGATION_BORROW_SIZE
  }

  return {
    address,
    lendingMarket: readPubkey(data, OBLIGATION_MARKET_OFFSET),
    deposits,
    borrows,
  }
}

function parseReserve(address: string, data: Uint8Array): ParsedReserve | null {
  if (data.length < RESERVE_ACCUMULATED_PROTOCOL_FEES_WADS_OFFSET + 16)
    return null

  return {
    address,
    lendingMarket: readPubkey(data, OBLIGATION_MARKET_OFFSET),
    liquidityMint: readPubkey(data, RESERVE_LIQUIDITY_MINT_OFFSET),
    liquidityDecimals: data[RESERVE_LIQUIDITY_DECIMALS_OFFSET] ?? 0,
    liquidityAvailableAmount: readU64LE(
      data,
      RESERVE_LIQUIDITY_AVAILABLE_AMOUNT_OFFSET,
    ),
    liquidityBorrowedAmountWads: readU128LE(
      data,
      RESERVE_LIQUIDITY_BORROWED_AMOUNT_WADS_OFFSET,
    ),
    liquidityCumulativeBorrowRateWads: readU128LE(
      data,
      RESERVE_LIQUIDITY_CUMULATIVE_BORROW_RATE_WADS_OFFSET,
    ),
    collateralMint: readPubkey(data, RESERVE_COLLATERAL_MINT_OFFSET),
    collateralMintTotalSupply: readU64LE(
      data,
      RESERVE_COLLATERAL_MINT_TOTAL_SUPPLY_OFFSET,
    ),
    accumulatedProtocolFeesWads: readU128LE(
      data,
      RESERVE_ACCUMULATED_PROTOCOL_FEES_WADS_OFFSET,
    ),
  }
}

function readTokenAccountMint(data: Uint8Array): string {
  return readPubkey(data, TOKEN_ACCOUNT_MINT_OFFSET)
}

function readTokenAccountAmount(data: Uint8Array): bigint {
  return readU64LE(data, TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function toUsdValue(
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
}

function sumUsdValues(values: Array<string | undefined>): string | undefined {
  const numeric = values
    .filter((value): value is string => value !== undefined)
    .map(Number)
  if (numeric.length === 0) return undefined
  return numeric.reduce((sum, value) => sum + value, 0).toString()
}

function buildSuppliedAsset(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  tokens: SolanaPlugins['tokens'],
): LendingSuppliedAsset {
  const token = tokens.get(mint)
  const usdValue = toUsdValue(amountRaw, decimals, token?.priceUsd)
  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function buildBorrowedAsset(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  tokens: SolanaPlugins['tokens'],
): LendingBorrowedAsset {
  const token = tokens.get(mint)
  const usdValue = toUsdValue(amountRaw, decimals, token?.priceUsd)
  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function collateralToUnderlyingAmount(
  collateralAmount: bigint,
  reserve: ParsedReserve,
): bigint {
  if (reserve.collateralMintTotalSupply === 0n) return 0n

  const totalSupplyRaw =
    reserve.liquidityAvailableAmount +
    reserve.liquidityBorrowedAmountWads / WAD -
    reserve.accumulatedProtocolFeesWads / WAD

  if (totalSupplyRaw <= 0n) return 0n

  return (collateralAmount * totalSupplyRaw) / reserve.collateralMintTotalSupply
}

function borrowWadsToUnderlyingAmount(
  borrowedAmountWads: bigint,
  cumulativeBorrowRateWads: bigint,
  reserve: ParsedReserve,
): bigint {
  if (cumulativeBorrowRateWads === 0n) return 0n
  if (reserve.liquidityCumulativeBorrowRateWads === 0n) return 0n

  return (
    (borrowedAmountWads * reserve.liquidityCumulativeBorrowRateWads) /
    cumulativeBorrowRateWads /
    WAD
  )
}

export const saveIntegration: SolanaIntegration = {
  platformId: 'save',

  getUserPositions: async function* (
    address: string,
    { tokens }: SolanaPlugins,
  ): UserPositionsPlan {
    const walletAddress = new PublicKey(address).toBase58()

    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = tokens.get(token)
        if (tokenData === undefined) return undefined
        if (tokenData.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    const phase0 = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: SAVE_PROGRAM_ID,
        filters: [
          { memcmp: { offset: OBLIGATION_OWNER_OFFSET, bytes: walletAddress } },
        ],
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: walletAddress,
        programId: TOKEN_PROGRAM_ID_STR,
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: walletAddress,
        programId: TOKEN_2022_PROGRAM_ID_STR,
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]

    const obligations: ParsedObligation[] = []
    const userCollateralMintBalances = new Map<string, bigint>()

    for (const account of Object.values(phase0)) {
      if (!account.exists) continue

      if (account.programAddress === SAVE_PROGRAM_ID) {
        const obligation = parseObligation(account.address, account.data)
        if (obligation) obligations.push(obligation)
        continue
      }

      if (
        (account.programAddress === TOKEN_PROGRAM_ID_STR ||
          account.programAddress === TOKEN_2022_PROGRAM_ID_STR) &&
        account.data.length >= TOKEN_ACCOUNT_MIN_SIZE
      ) {
        const mint = readTokenAccountMint(account.data)
        const amount = readTokenAccountAmount(account.data)
        if (amount === 0n) continue
        userCollateralMintBalances.set(
          mint,
          (userCollateralMintBalances.get(mint) ?? 0n) + amount,
        )
      }
    }

    const reservesMap = yield {
      kind: 'getProgramAccounts' as const,
      programId: SAVE_PROGRAM_ID,
      filters: [{ dataSize: RESERVE_ACCOUNT_SIZE }],
    }

    const reservesByAddress = new Map<string, ParsedReserve>()
    const reservesByCollateralMint = new Map<string, ParsedReserve>()

    for (const account of Object.values(reservesMap)) {
      if (!account.exists) continue

      const reserve = parseReserve(account.address, account.data)
      if (!reserve) continue
      if (
        reserve.collateralMint === DEFAULT_PUBLIC_KEY ||
        reserve.liquidityMint === DEFAULT_PUBLIC_KEY
      ) {
        continue
      }

      reservesByAddress.set(reserve.address, reserve)
      reservesByCollateralMint.set(reserve.collateralMint, reserve)
    }

    const positions: UserDefiPosition[] = []

    for (const obligation of obligations) {
      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []

      for (const deposit of obligation.deposits) {
        const reserve = reservesByAddress.get(deposit.reserve)
        if (!reserve) continue

        const suppliedAmountRaw = collateralToUnderlyingAmount(
          deposit.depositedAmount,
          reserve,
        )
        if (suppliedAmountRaw <= 0n) continue

        supplied.push(
          buildSuppliedAsset(
            reserve.liquidityMint,
            suppliedAmountRaw,
            reserve.liquidityDecimals,
            tokens,
          ),
        )
      }

      for (const debt of obligation.borrows) {
        const reserve = reservesByAddress.get(debt.reserve)
        if (!reserve) continue

        const borrowedAmountRaw = borrowWadsToUnderlyingAmount(
          debt.borrowedAmountWads,
          debt.cumulativeBorrowRateWads,
          reserve,
        )
        if (borrowedAmountRaw <= 0n) continue

        borrowed.push(
          buildBorrowedAsset(
            reserve.liquidityMint,
            borrowedAmountRaw,
            reserve.liquidityDecimals,
            tokens,
          ),
        )
      }

      if (supplied.length === 0 && borrowed.length === 0) continue

      const suppliedUsd = sumUsdValues(supplied.map((asset) => asset.usdValue))
      const borrowedUsd = sumUsdValues(borrowed.map((asset) => asset.usdValue))

      const position: LendingDefiPosition = {
        platformId: 'save',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        meta: {
          obligation: {
            address: obligation.address,
            lendingMarket: obligation.lendingMarket,
          },
        },
      }

      if (suppliedUsd !== undefined || borrowedUsd !== undefined) {
        position.usdValue = (
          Number(suppliedUsd ?? '0') - Number(borrowedUsd ?? '0')
        ).toString()
      }

      positions.push(position)
    }

    const collateralOnlySupplied: LendingSuppliedAsset[] = []
    for (const [mint, balance] of userCollateralMintBalances) {
      if (balance <= 0n) continue

      const reserve = reservesByCollateralMint.get(mint)
      if (!reserve) continue

      const suppliedAmountRaw = collateralToUnderlyingAmount(balance, reserve)
      if (suppliedAmountRaw <= 0n) continue

      collateralOnlySupplied.push(
        buildSuppliedAsset(
          reserve.liquidityMint,
          suppliedAmountRaw,
          reserve.liquidityDecimals,
          tokens,
        ),
      )
    }

    if (collateralOnlySupplied.length > 0) {
      const collateralOnlyUsdValue = sumUsdValues(
        collateralOnlySupplied.map((asset) => asset.usdValue),
      )
      positions.push({
        platformId: 'save',
        positionKind: 'lending',
        supplied: collateralOnlySupplied,
        ...(collateralOnlyUsdValue !== undefined && {
          usdValue: collateralOnlyUsdValue,
        }),
        meta: {
          source: {
            type: 'wallet-collateral',
          },
        },
      })
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: SAVE_PROGRAM_ID,
      ownerOffset: OBLIGATION_OWNER_OFFSET,
    },
  ],
}

export default saveIntegration
