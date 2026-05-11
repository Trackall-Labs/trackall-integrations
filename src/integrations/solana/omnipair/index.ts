import { BorshCoder } from '@coral-xyz/anchor'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type {
  ConstantProductLiquidityDefiPosition,
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
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'
import omnipairIdl from './idls/omnipair.json'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const OMNIPAIR_PROGRAM_ID = omnipairIdl.address

export const PROGRAM_IDS = [
  OMNIPAIR_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

type OmnipairIdl = {
  accounts?: Array<{ name: string; discriminator?: number[] }>
}

interface PairAccount {
  address: string
  decoded: {
    token0: PublicKey
    token1: PublicKey
    lp_mint: PublicKey
    reserve0: unknown
    reserve1: unknown
    total_debt0: unknown
    total_debt1: unknown
    total_debt0_shares: unknown
    total_debt1_shares: unknown
    total_supply: unknown
    token0_decimals: number
    token1_decimals: number
  }
}

interface UserPositionAccount {
  decoded: {
    pair: PublicKey
    collateral0: unknown
    collateral1: unknown
    debt0_shares: unknown
    debt1_shares: unknown
  }
}

const omnipairCoder = new BorshCoder(omnipairIdl as never)
const PAIR_DISCRIMINATOR_B64 = accountDiscriminatorBase64(
  omnipairIdl as OmnipairIdl,
  'Pair',
)
const USER_POSITION_DISCRIMINATOR_B64 = accountDiscriminatorBase64(
  omnipairIdl as OmnipairIdl,
  'UserPosition',
)
const USER_POSITION_DISCRIMINATOR = Uint8Array.from(
  Buffer.from(USER_POSITION_DISCRIMINATOR_B64, 'base64'),
)

function accountDiscriminatorBase64(idl: OmnipairIdl, accountName: string) {
  const discriminator = idl.accounts?.find(
    (item) => item.name === accountName,
  )?.discriminator
  if (!discriminator) {
    throw new Error(`Missing discriminator for account "${accountName}"`)
  }
  return Buffer.from(discriminator).toString('base64')
}

function toBase58(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58()
  if (typeof value === 'string') return value
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toBase58?: unknown }).toBase58 === 'function'
  ) {
    return (value as { toBase58: () => string }).toBase58()
  }
  return PublicKey.default.toBase58()
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value))
    return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  if (
    value !== null &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    const numeric = value.toString()
    if (/^-?\d+$/.test(numeric)) return BigInt(numeric)
  }
  return 0n
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n
  if (numerator <= 0n) return 0n
  return (numerator + denominator - 1n) / denominator
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
  const present = values
    .filter((value): value is string => value !== undefined)
    .map(Number)
  if (present.length === 0) return undefined
  return present.reduce((sum, value) => sum + value, 0).toString()
}

function netUsdValue(
  supplied: LendingSuppliedAsset[],
  borrowed: LendingBorrowedAsset[],
): string | undefined {
  const suppliedUsd = supplied
    .map((asset) => asset.usdValue)
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .reduce((sum, value) => sum + value, 0)
  const borrowedUsd = borrowed
    .map((asset) => asset.usdValue)
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .reduce((sum, value) => sum + value, 0)
  if (
    supplied.every((asset) => asset.usdValue === undefined) &&
    borrowed.every((asset) => asset.usdValue === undefined)
  ) {
    return undefined
  }
  return (suppliedUsd - borrowedUsd).toString()
}

function buildSuppliedAsset(
  token: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): LendingSuppliedAsset {
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

function buildBorrowedAsset(
  token: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): LendingBorrowedAsset {
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

export const omnipairIntegration: SolanaIntegration = {
  platformId: 'omnipair',

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

    const wallet = new PublicKey(address)

    const phase0Map = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: OMNIPAIR_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: PAIR_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: OMNIPAIR_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: USER_POSITION_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          { memcmp: { offset: 8, bytes: wallet.toBase58() } },
        ],
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: wallet.toBase58(),
        programId: TOKEN_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: wallet.toBase58(),
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]

    const pairsByAddress = new Map<string, PairAccount>()
    const userPositions: UserPositionAccount[] = []
    const lpBalancesByMint = new Map<string, bigint>()

    for (const account of Object.values(phase0Map)) {
      if (!account.exists) continue
      if (account.programAddress === OMNIPAIR_PROGRAM_ID) {
        try {
          const pairDecoded = omnipairCoder.accounts.decode(
            'Pair',
            Buffer.from(account.data),
          ) as PairAccount['decoded']
          pairsByAddress.set(account.address, {
            address: account.address,
            decoded: pairDecoded,
          })
          continue
        } catch {}

        try {
          const positionDecoded = omnipairCoder.accounts.decode(
            'UserPosition',
            Buffer.from(account.data),
          ) as UserPositionAccount['decoded']
          userPositions.push({
            decoded: positionDecoded,
          })
        } catch {}
        continue
      }

      if (
        account.programAddress !== TOKEN_PROGRAM_ID.toBase58() &&
        account.programAddress !== TOKEN_2022_PROGRAM_ID.toBase58()
      ) {
        continue
      }

      const data = Buffer.from(account.data)
      if (data.length < 72) continue
      const mint = new PublicKey(data.subarray(0, 32)).toBase58()
      const amount = data.readBigUInt64LE(64)
      if (amount === 0n) continue
      lpBalancesByMint.set(mint, (lpBalancesByMint.get(mint) ?? 0n) + amount)
    }

    const result: UserDefiPosition[] = []

    for (const { decoded } of userPositions) {
      const pairAddress = toBase58(decoded.pair)
      const pair = pairsByAddress.get(pairAddress)
      if (!pair) continue

      const token0 = toBase58(pair.decoded.token0)
      const token1 = toBase58(pair.decoded.token1)
      const collateral0 = toBigInt(decoded.collateral0)
      const collateral1 = toBigInt(decoded.collateral1)
      const debt0Shares = toBigInt(decoded.debt0_shares)
      const debt1Shares = toBigInt(decoded.debt1_shares)
      const totalDebt0 = toBigInt(pair.decoded.total_debt0)
      const totalDebt1 = toBigInt(pair.decoded.total_debt1)
      const totalDebt0Shares = toBigInt(pair.decoded.total_debt0_shares)
      const totalDebt1Shares = toBigInt(pair.decoded.total_debt1_shares)
      const debt0 = ceilDiv(debt0Shares * totalDebt0, totalDebt0Shares)
      const debt1 = ceilDiv(debt1Shares * totalDebt1, totalDebt1Shares)
      const decimals0 = pair.decoded.token0_decimals
      const decimals1 = pair.decoded.token1_decimals
      const token0PriceUsd = tokens.get(token0)?.priceUsd
      const token1PriceUsd = tokens.get(token1)?.priceUsd

      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []
      if (collateral0 > 0n) {
        supplied.push(
          buildSuppliedAsset(token0, collateral0, decimals0, token0PriceUsd),
        )
      }
      if (collateral1 > 0n) {
        supplied.push(
          buildSuppliedAsset(token1, collateral1, decimals1, token1PriceUsd),
        )
      }
      if (debt0 > 0n) {
        borrowed.push(
          buildBorrowedAsset(token0, debt0, decimals0, token0PriceUsd),
        )
      }
      if (debt1 > 0n) {
        borrowed.push(
          buildBorrowedAsset(token1, debt1, decimals1, token1PriceUsd),
        )
      }
      if (supplied.length === 0 && borrowed.length === 0) continue

      const usdValue = netUsdValue(supplied, borrowed)
      result.push({
        positionKind: 'lending',
        platformId: 'omnipair',
        ...(usdValue !== undefined && { usdValue }),
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        meta: {
          omnipair: {
            pair: pairAddress,
          },
        },
      } satisfies LendingDefiPosition)
    }

    for (const pair of pairsByAddress.values()) {
      const lpMint = toBase58(pair.decoded.lp_mint)
      const userLpBalance = lpBalancesByMint.get(lpMint)
      if (!userLpBalance || userLpBalance === 0n) continue

      const totalSupply = toBigInt(pair.decoded.total_supply)
      if (totalSupply === 0n) continue

      const reserve0 = toBigInt(pair.decoded.reserve0)
      const reserve1 = toBigInt(pair.decoded.reserve1)
      const token0 = toBase58(pair.decoded.token0)
      const token1 = toBase58(pair.decoded.token1)
      const decimals0 = pair.decoded.token0_decimals
      const decimals1 = pair.decoded.token1_decimals
      const amount0 = (userLpBalance * reserve0) / totalSupply
      const amount1 = (userLpBalance * reserve1) / totalSupply
      const token0PriceUsd = tokens.get(token0)?.priceUsd
      const token1PriceUsd = tokens.get(token1)?.priceUsd
      const usd0 = buildUsdValue(amount0, decimals0, token0PriceUsd)
      const usd1 = buildUsdValue(amount1, decimals1, token1PriceUsd)
      const usdValue = sumUsdValues([usd0, usd1])

      result.push({
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        platformId: 'omnipair',
        poolAddress: pair.address,
        lpTokenAmount: userLpBalance.toString(),
        ...(usdValue !== undefined && { usdValue }),
        poolTokens: [
          {
            amount: {
              token: token0,
              amount: amount0.toString(),
              decimals: decimals0.toString(),
            },
            ...(token0PriceUsd !== undefined && {
              priceUsd: token0PriceUsd.toString(),
            }),
            ...(usd0 !== undefined && { usdValue: usd0 }),
          },
          {
            amount: {
              token: token1,
              amount: amount1.toString(),
              decimals: decimals1.toString(),
            },
            ...(token1PriceUsd !== undefined && {
              priceUsd: token1PriceUsd.toString(),
            }),
            ...(usd1 !== undefined && { usdValue: usd1 }),
          },
        ],
        meta: {
          omnipair: {
            lpMint,
          },
        },
      } satisfies ConstantProductLiquidityDefiPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)

    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: OMNIPAIR_PROGRAM_ID,
      discriminator: USER_POSITION_DISCRIMINATOR,
      ownerOffset: 8,
    },
  ],
}

export default omnipairIntegration
