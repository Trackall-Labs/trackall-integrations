import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type {
  ConstantProductLiquidityDefiPosition,
  MaybeSolanaAccount,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  // UsersFilter,
  // UsersFilterPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'

const SABER_SWAP_PROGRAM_ID = 'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ'

const SWAP_ACCOUNT_SIZE = 395
// const TOKEN_ACCOUNT_MINT_OFFSET = 0
// const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const MINT_SUPPLY_OFFSET = 36
const MINT_DECIMALS_OFFSET = 44

const SWAP_TOKEN_A_RESERVE_OFFSET = 107
const SWAP_TOKEN_B_RESERVE_OFFSET = 139
const SWAP_POOL_MINT_OFFSET = 171
const SWAP_TOKEN_A_MINT_OFFSET = 203
const SWAP_TOKEN_B_MINT_OFFSET = 235

type SaberPool = {
  poolAddress: string
  poolMint: string
  tokenAReserve: string
  tokenBReserve: string
  tokenAMint: string
  tokenBMint: string
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  SABER_SWAP_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 32) return null
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function readTokenAmount(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return null
  return buf.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function readMintSupply(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < MINT_SUPPLY_OFFSET + 8) return null
  return buf.readBigUInt64LE(MINT_SUPPLY_OFFSET)
}

function readMintDecimals(data: Uint8Array): number | null {
  const buf = Buffer.from(data)
  if (buf.length < MINT_DECIMALS_OFFSET + 1) return null
  return buf.readUInt8(MINT_DECIMALS_OFFSET)
}

function parsePool(account: MaybeSolanaAccount): SaberPool | null {
  if (!account.exists) return null
  if (account.programAddress !== SABER_SWAP_PROGRAM_ID) return null

  const data = account.data
  if (data.length < SWAP_ACCOUNT_SIZE) return null
  if (data[0] !== 1) return null

  const tokenAReserve = readPubkey(data, SWAP_TOKEN_A_RESERVE_OFFSET)
  const tokenBReserve = readPubkey(data, SWAP_TOKEN_B_RESERVE_OFFSET)
  const poolMint = readPubkey(data, SWAP_POOL_MINT_OFFSET)
  const tokenAMint = readPubkey(data, SWAP_TOKEN_A_MINT_OFFSET)
  const tokenBMint = readPubkey(data, SWAP_TOKEN_B_MINT_OFFSET)
  if (
    !tokenAReserve ||
    !tokenBReserve ||
    !poolMint ||
    !tokenAMint ||
    !tokenBMint
  )
    return null

  return {
    poolAddress: account.address,
    poolMint,
    tokenAReserve,
    tokenBReserve,
    tokenAMint,
    tokenBMint,
  }
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
  const present = values
    .filter((value): value is string => value !== undefined)
    .map(Number)

  if (present.length === 0) return undefined
  return present.reduce((sum, value) => sum + value, 0).toString()
}

// function buildTokenHolderUsersFiltersByMints(
//   mints: Iterable<string>,
// ): UsersFilter[] {
//   const filters: UsersFilter[] = []
//   const tokenProgramIds = [
//     TOKEN_PROGRAM_ID.toBase58(),
//     TOKEN_2022_PROGRAM_ID.toBase58(),
//   ]
//
//   for (const mint of new Set(mints)) {
//     let mintBytes: Uint8Array
//     try {
//       mintBytes = new PublicKey(mint).toBytes()
//     } catch {
//       continue
//     }
//
//     for (const programId of tokenProgramIds) {
//       filters.push({
//         programId,
//         ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
//         memcmps: [{ offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mintBytes }],
//       })
//     }
//   }
//
//   return filters
// }

export const saberIntegration: SolanaIntegration = {
  platformId: 'saber',

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
      {
        kind: 'getProgramAccounts' as const,
        programId: SABER_SWAP_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [{ dataSize: SWAP_ACCOUNT_SIZE }],
      },
    ]

    const lpBalancesByMint = new Map<string, bigint>()
    for (const account of Object.values(phase0Map)) {
      if (!account.exists) continue
      if (
        account.programAddress !== TOKEN_PROGRAM_ID.toBase58() &&
        account.programAddress !== TOKEN_2022_PROGRAM_ID.toBase58()
      ) {
        continue
      }

      const mint = readPubkey(account.data, 0)
      const amount = readTokenAmount(account.data)
      if (!mint || amount === null || amount === 0n) continue

      const existing = lpBalancesByMint.get(mint) ?? 0n
      lpBalancesByMint.set(mint, existing + amount)
    }

    if (lpBalancesByMint.size === 0) return []

    const matchedPools = Object.values(phase0Map)
      .map((account) => parsePool(account))
      .filter((pool): pool is SaberPool => pool !== null)
      .filter((pool) => lpBalancesByMint.has(pool.poolMint))

    if (matchedPools.length === 0) return []

    const round1Addresses = new Set<string>()
    for (const pool of matchedPools) {
      round1Addresses.add(pool.tokenAReserve)
      round1Addresses.add(pool.tokenBReserve)
      round1Addresses.add(pool.poolMint)
      round1Addresses.add(pool.tokenAMint)
      round1Addresses.add(pool.tokenBMint)
    }

    const round1Map = yield [...round1Addresses]

    const positions: UserDefiPosition[] = []
    for (const pool of matchedPools) {
      const userLpAmount = lpBalancesByMint.get(pool.poolMint)
      if (!userLpAmount || userLpAmount === 0n) continue

      const reserveAAccount = round1Map[pool.tokenAReserve]
      const reserveBAccount = round1Map[pool.tokenBReserve]
      const lpMintAccount = round1Map[pool.poolMint]
      const tokenAMintAccount = round1Map[pool.tokenAMint]
      const tokenBMintAccount = round1Map[pool.tokenBMint]
      if (
        !reserveAAccount?.exists ||
        !reserveBAccount?.exists ||
        !lpMintAccount?.exists ||
        !tokenAMintAccount?.exists ||
        !tokenBMintAccount?.exists
      ) {
        continue
      }

      const reserveA = readTokenAmount(reserveAAccount.data)
      const reserveB = readTokenAmount(reserveBAccount.data)
      const lpSupply = readMintSupply(lpMintAccount.data)
      const tokenADecimals = readMintDecimals(tokenAMintAccount.data)
      const tokenBDecimals = readMintDecimals(tokenBMintAccount.data)

      if (
        reserveA === null ||
        reserveB === null ||
        lpSupply === null ||
        lpSupply === 0n ||
        tokenADecimals === null ||
        tokenBDecimals === null
      ) {
        continue
      }

      const amountA = (reserveA * userLpAmount) / lpSupply
      const amountB = (reserveB * userLpAmount) / lpSupply

      const tokenAInfo = tokens.get(pool.tokenAMint)
      const tokenBInfo = tokens.get(pool.tokenBMint)
      const usdA = buildUsdValue(amountA, tokenADecimals, tokenAInfo?.priceUsd)
      const usdB = buildUsdValue(amountB, tokenBDecimals, tokenBInfo?.priceUsd)
      const totalUsdValue = sumUsdValues([usdA, usdB])

      positions.push({
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        platformId: 'saber',
        poolAddress: pool.poolAddress,
        lpTokenAmount: userLpAmount.toString(),
        ...(totalUsdValue !== undefined && { usdValue: totalUsdValue }),
        poolTokens: [
          buildPositionValue(
            pool.tokenAMint,
            amountA,
            tokenADecimals,
            tokenAInfo?.priceUsd,
          ),
          buildPositionValue(
            pool.tokenBMint,
            amountB,
            tokenBDecimals,
            tokenBInfo?.priceUsd,
          ),
        ],
      } satisfies ConstantProductLiquidityDefiPosition)
    }

    positions.sort((a, b) => {
      const aPool = a.positionKind === 'liquidity' ? (a.poolAddress ?? '') : ''
      const bPool = b.positionKind === 'liquidity' ? (b.poolAddress ?? '') : ''
      return aPool.localeCompare(bPool)
    })

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  // getUsersFilter: async function* (): UsersFilterPlan {
  //   const poolAccounts = yield {
  //     kind: 'getProgramAccounts' as const,
  //     programId: SABER_SWAP_PROGRAM_ID,
  //     cacheTtlMs: ONE_HOUR_IN_MS,
  //     filters: [{ dataSize: SWAP_ACCOUNT_SIZE }],
  //   }

  //   const discoveredPoolMints = new Set<string>()
  //   for (const account of Object.values(poolAccounts)) {
  //     const pool = parsePool(account)
  //     if (!pool) continue
  //     discoveredPoolMints.add(pool.poolMint)
  //   }

  //   return buildTokenHolderUsersFiltersByMints(discoveredPoolMints)
  // },
}

export default saberIntegration
