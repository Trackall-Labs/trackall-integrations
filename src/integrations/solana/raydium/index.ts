import { BorshCoder } from '@coral-xyz/anchor'
import { AMM_V4, liquidityStateV4Layout } from '@raydium-io/raydium-sdk-v2'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

import type {
  ConcentratedRangeLiquidityDefiPosition,
  ConstantProductLiquidityDefiPosition,
  ProgramRequest,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  // UsersFilter,
  // UsersFilterPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'
import clmmIdl from './idls/amm_v3.json'
import cpIdl from './idls/raydium_cp_swap.json'

export const testAddress = '93PSyNrS7zBhrXaHHfU1ZtfegcKq5SaCYc35ZwPVrK3K'

// ─── Program IDs ─────────────────────────────────────────────────────────────
const CLMM_PROGRAM = new PublicKey(clmmIdl.address)
const CP_PROGRAM_ID = cpIdl.address

export const PROGRAM_IDS = [
  CLMM_PROGRAM.toBase58(),
  CP_PROGRAM_ID,
  AMM_V4.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

// ─── Discriminators (from IDL) ───────────────────────────────────────────────
function idlDiscriminator(
  idl: { accounts?: Array<{ name: string; discriminator?: number[] }> },
  accountName: string,
): number[] {
  const disc = idl.accounts?.find((a) => a.name === accountName)?.discriminator
  if (!disc) throw new Error(`Missing discriminator for "${accountName}"`)
  return disc
}

const PERSONAL_POSITION_DISC = Buffer.from(
  idlDiscriminator(clmmIdl, 'PersonalPositionState'),
)
// const PERSONAL_POSITION_DISC_B64 = PERSONAL_POSITION_DISC.toString('base64')
const CP_POOL_DISC_B64 = Buffer.from(
  idlDiscriminator(cpIdl, 'PoolState'),
).toString('base64')
const NFT_TOKEN_AMOUNT_RAW = 1n
const TOKEN_ACCOUNT_MINT_OFFSET = 0
// const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const CP_LP_MINT_OFFSET = 136
// const AMM_V4_LP_MINT_OFFSET = 464

// ─── BorshCoder for PersonalPositionState ────────────────────────────────────
const clmmCoder = new BorshCoder(clmmIdl as never)

// ─── Manual offset helpers ───────────────────────────────────────────────────
function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.slice(offset, offset + 32)).toBase58()
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset)
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset)
  const hi = buf.readBigUInt64LE(offset + 8)
  return lo | (hi << 64n)
}

function readI32LE(buf: Buffer, offset: number): number {
  return buf.readInt32LE(offset)
}

function readU16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset)
}

// ─── CLMM PoolState manual offsets (repr(C, packed), 8-byte discriminator) ──
function decodeClmmPool(buf: Buffer) {
  return {
    tokenMint0: readPubkey(buf, 73),
    tokenMint1: readPubkey(buf, 105),
    mintDecimals0: buf.readUInt8(233),
    mintDecimals1: buf.readUInt8(234),
    tickSpacing: readU16LE(buf, 235),
    liquidity: readU128LE(buf, 237),
    sqrtPriceX64: readU128LE(buf, 253),
    tickCurrent: readI32LE(buf, 269),
  }
}

// ─── CP PoolState manual offsets (repr(C, packed), 8-byte discriminator) ─────
function decodeCpPool(buf: Buffer) {
  return {
    token0Vault: readPubkey(buf, 72),
    token1Vault: readPubkey(buf, 104),
    lpMint: readPubkey(buf, 136),
    token0Mint: readPubkey(buf, 168),
    token1Mint: readPubkey(buf, 200),
    mintDecimals0: buf.readUInt8(331),
    mintDecimals1: buf.readUInt8(332),
    lpSupply: readU64LE(buf, 333),
    protocolFeesToken0: readU64LE(buf, 341),
    protocolFeesToken1: readU64LE(buf, 349),
    fundFeesToken0: readU64LE(buf, 357),
    fundFeesToken1: readU64LE(buf, 365),
    creatorFeesToken0: readU64LE(buf, 397),
    creatorFeesToken1: readU64LE(buf, 405),
  }
}

function subtractClamp(value: bigint, decrement: bigint): bigint {
  return value > decrement ? value - decrement : 0n
}

export function computeCpUserAmounts(params: {
  vault0Balance: bigint
  vault1Balance: bigint
  userLpAmount: bigint
  lpSupply: bigint
  protocolFeesToken0: bigint
  protocolFeesToken1: bigint
  fundFeesToken0: bigint
  fundFeesToken1: bigint
  creatorFeesToken0: bigint
  creatorFeesToken1: bigint
}): { amount0: bigint; amount1: bigint } {
  const {
    vault0Balance,
    vault1Balance,
    userLpAmount,
    lpSupply,
    protocolFeesToken0,
    protocolFeesToken1,
    fundFeesToken0,
    fundFeesToken1,
    creatorFeesToken0,
    creatorFeesToken1,
  } = params

  if (lpSupply === 0n) return { amount0: 0n, amount1: 0n }

  const effectiveVault0 = subtractClamp(
    subtractClamp(
      subtractClamp(vault0Balance, protocolFeesToken0),
      fundFeesToken0,
    ),
    creatorFeesToken0,
  )
  const effectiveVault1 = subtractClamp(
    subtractClamp(
      subtractClamp(vault1Balance, protocolFeesToken1),
      fundFeesToken1,
    ),
    creatorFeesToken1,
  )

  return {
    amount0: (effectiveVault0 * userLpAmount) / lpSupply,
    amount1: (effectiveVault1 * userLpAmount) / lpSupply,
  }
}

export function computeAmmV4UserAmounts(params: {
  baseVaultBalance: bigint
  quoteVaultBalance: bigint
  userLpAmount: bigint
  lpReserve: bigint
  baseNeedTakePnl: bigint
  quoteNeedTakePnl: bigint
}): { amount0: bigint; amount1: bigint } {
  const {
    baseVaultBalance,
    quoteVaultBalance,
    userLpAmount,
    lpReserve,
    baseNeedTakePnl,
    quoteNeedTakePnl,
  } = params

  if (lpReserve === 0n) return { amount0: 0n, amount1: 0n }

  const effectiveBaseReserve = subtractClamp(baseVaultBalance, baseNeedTakePnl)
  const effectiveQuoteReserve = subtractClamp(
    quoteVaultBalance,
    quoteNeedTakePnl,
  )

  return {
    amount0: (effectiveBaseReserve * userLpAmount) / lpReserve,
    amount1: (effectiveQuoteReserve * userLpAmount) / lpReserve,
  }
}

// ─── CLMM math (Uniswap v3 style with Q64.64 BigInt) ────────────────────────
const Q64 = 1n << 64n

/**
 * Compute sqrt(1.0001^tick) as a Q64.64 fixed-point value.
 * Uses the identity: sqrtPrice = 1.0001^(tick/2)
 * We compute this with floating point then convert to Q64.
 */
function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = 1.0001 ** (tick / 2)
  // Convert to Q64.64
  return BigInt(Math.round(sqrtPrice * Number(Q64)))
}

/**
 * Compute token amounts from a CLMM position using BigInt Q64 arithmetic.
 */
function computeClmmAmounts(
  liquidity: bigint,
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
  sqrtPriceX64: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtPriceLowerX64 = tickToSqrtPriceX64(tickLower)
  const sqrtPriceUpperX64 = tickToSqrtPriceX64(tickUpper)

  let amount0 = 0n
  let amount1 = 0n

  if (tickCurrent < tickLower) {
    // All token0: L * (1/sqrtLower - 1/sqrtUpper) = L * Q64 * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper)
    amount0 =
      (liquidity * Q64 * (sqrtPriceUpperX64 - sqrtPriceLowerX64)) /
      (sqrtPriceLowerX64 * sqrtPriceUpperX64)
  } else if (tickCurrent >= tickUpper) {
    // All token1: L * (sqrtUpper - sqrtLower) / Q64
    amount1 = (liquidity * (sqrtPriceUpperX64 - sqrtPriceLowerX64)) / Q64
  } else {
    // Mixed: current price is in range
    amount0 =
      (liquidity * Q64 * (sqrtPriceUpperX64 - sqrtPriceX64)) /
      (sqrtPriceX64 * sqrtPriceUpperX64)
    amount1 = (liquidity * (sqrtPriceX64 - sqrtPriceLowerX64)) / Q64
  }

  return { amount0, amount1 }
}

/**
 * Compute price from sqrtPriceX64: price = (sqrtPriceX64 / 2^64)^2 * 10^(decimals0 - decimals1)
 */
function sqrtPriceX64ToPrice(
  sqrtPriceX64: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const sqrtPrice = Number(sqrtPriceX64) / Number(Q64)
  return sqrtPrice * sqrtPrice * 10 ** (decimals0 - decimals1)
}

function tickToPrice(
  tick: number,
  decimals0: number,
  decimals1: number,
): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1)
}

// ─── SPL token account reading ───────────────────────────────────────────────
function readTokenAccountMint(data: Uint8Array): string | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_MINT_OFFSET + 32) return null
  return readPubkey(buf, TOKEN_ACCOUNT_MINT_OFFSET)
}

function readTokenAccountAmount(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < 72) return null
  return readU64LE(buf, 64)
}

// export function buildTokenHolderUsersFiltersByMints(
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

// ─── Integration ─────────────────────────────────────────────────────────────

export const raydiumIntegration: SolanaIntegration = {
  platformId: 'raydium',

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

    // ── Phase 0: Get user's SPL + Token-2022 accounts in parallel ─────────
    const userTokenMap = yield [
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: walletPubkey.toBase58(),
        programId: TOKEN_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: walletPubkey.toBase58(),
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]

    // Build mint → amount maps:
    // - userSplMintBalances: SPL only (used by CP/AMM)
    // - userToken2022MintBalances: Token-2022 balances (used to detect NFT-like CLMM mints)
    const token2022ProgramId = TOKEN_2022_PROGRAM_ID.toBase58()
    const tokenProgramId = TOKEN_PROGRAM_ID.toBase58()
    const userSplMintBalances = new Map<string, bigint>()
    const userToken2022MintBalances = new Map<string, bigint>()
    for (const acc of Object.values(userTokenMap)) {
      if (!acc.exists) continue
      const mint = readTokenAccountMint(acc.data)
      const amount = readTokenAccountAmount(acc.data)
      if (mint && amount !== null && amount > 0n) {
        if (acc.programAddress === tokenProgramId) {
          const splExisting = userSplMintBalances.get(mint)
          userSplMintBalances.set(
            mint,
            splExisting !== undefined ? splExisting + amount : amount,
          )
        }
        if (acc.programAddress === token2022ProgramId) {
          const token2022Existing = userToken2022MintBalances.get(mint)
          userToken2022MintBalances.set(
            mint,
            token2022Existing !== undefined
              ? token2022Existing + amount
              : amount,
          )
        }
      }
    }

    const userToken2022NftMints = new Set<string>()
    for (const [mint, amount] of userToken2022MintBalances) {
      if (amount === NFT_TOKEN_AMOUNT_RAW) userToken2022NftMints.add(mint)
    }

    if (userSplMintBalances.size === 0 && userToken2022NftMints.size === 0)
      return []

    // ── Phase 1: Fetch CP pools matching user's LP mints ───────────────────
    interface CpPoolMatch {
      poolAddress: string
      token0Mint: string
      token1Mint: string
      token0Vault: string
      token1Vault: string
      mintDecimals0: number
      mintDecimals1: number
      lpSupply: bigint
      protocolFeesToken0: bigint
      protocolFeesToken1: bigint
      fundFeesToken0: bigint
      fundFeesToken1: bigint
      creatorFeesToken0: bigint
      creatorFeesToken1: bigint
      userLpAmount: bigint
    }

    const cpMatches: CpPoolMatch[] = []
    const cpVaultAddresses: string[] = []

    interface AmmV4Match {
      poolAddress: string
      baseMint: string
      quoteMint: string
      baseVault: string
      quoteVault: string
      baseDecimal: number
      quoteDecimal: number
      baseNeedTakePnl: bigint
      quoteNeedTakePnl: bigint
      lpReserve: bigint
      userLpAmount: bigint
    }
    const ammV4Matches: AmmV4Match[] = []

    const poolDiscoveryRequests: ProgramRequest[] = []
    for (const mint of userSplMintBalances.keys()) {
      poolDiscoveryRequests.push(
        {
          kind: 'getProgramAccounts' as const,
          programId: CP_PROGRAM_ID,
          cacheTtlMs: ONE_HOUR_IN_MS,
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: CP_POOL_DISC_B64,
                encoding: 'base64' as const,
              },
            },
            { memcmp: { offset: CP_LP_MINT_OFFSET, bytes: mint } },
          ],
        },
        {
          kind: 'getProgramAccounts' as const,
          programId: AMM_V4.toBase58(),
          cacheTtlMs: ONE_HOUR_IN_MS,
          filters: [
            { dataSize: 752 },
            { memcmp: { offset: 464, bytes: mint } },
          ],
        },
      )
    }

    const discoveredPools =
      poolDiscoveryRequests.length > 0 ? yield poolDiscoveryRequests : {}

    for (const acc of Object.values(discoveredPools)) {
      if (!acc.exists) continue
      const buf = Buffer.from(acc.data)

      if (acc.programAddress === CP_PROGRAM_ID) {
        if (buf.length < 413) continue
        const pool = decodeCpPool(buf)
        const userLpAmount = userSplMintBalances.get(pool.lpMint)
        if (userLpAmount === undefined) continue
        cpMatches.push({
          poolAddress: acc.address,
          token0Mint: pool.token0Mint,
          token1Mint: pool.token1Mint,
          token0Vault: pool.token0Vault,
          token1Vault: pool.token1Vault,
          mintDecimals0: pool.mintDecimals0,
          mintDecimals1: pool.mintDecimals1,
          lpSupply: pool.lpSupply,
          protocolFeesToken0: pool.protocolFeesToken0,
          protocolFeesToken1: pool.protocolFeesToken1,
          fundFeesToken0: pool.fundFeesToken0,
          fundFeesToken1: pool.fundFeesToken1,
          creatorFeesToken0: pool.creatorFeesToken0,
          creatorFeesToken1: pool.creatorFeesToken1,
          userLpAmount,
        })
        cpVaultAddresses.push(pool.token0Vault, pool.token1Vault)
        continue
      }

      if (acc.programAddress !== AMM_V4.toBase58()) continue
      if (buf.length < 752) continue

      const pool = liquidityStateV4Layout.decode(buf)
      const lpMint = pool.lpMint.toBase58()
      const userLpAmount = userSplMintBalances.get(lpMint)
      if (userLpAmount === undefined) continue

      ammV4Matches.push({
        poolAddress: acc.address,
        baseMint: pool.baseMint.toBase58(),
        quoteMint: pool.quoteMint.toBase58(),
        baseVault: pool.baseVault.toBase58(),
        quoteVault: pool.quoteVault.toBase58(),
        baseDecimal: Number(pool.baseDecimal),
        quoteDecimal: Number(pool.quoteDecimal),
        baseNeedTakePnl: BigInt(pool.baseNeedTakePnl.toString()),
        quoteNeedTakePnl: BigInt(pool.quoteNeedTakePnl.toString()),
        lpReserve: BigInt(pool.lpReserve.toString()),
        userLpAmount,
      })
    }

    // Collect AMM v4 addresses for phase 2
    const ammV4VaultAddresses: string[] = []
    for (const m of ammV4Matches) {
      ammV4VaultAddresses.push(m.baseVault, m.quoteVault)
    }

    // Derive CLMM PersonalPositionState PDAs for Token-2022 NFT-like user mints only (amount=1)
    const clmmPdaEntries: { mint: string; pda: string }[] = []
    for (const mint of userToken2022NftMints) {
      try {
        const mintPubkey = new PublicKey(mint)
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('position'), mintPubkey.toBuffer()],
          CLMM_PROGRAM,
        )
        clmmPdaEntries.push({ mint, pda: pda.toBase58() })
      } catch {
        // invalid mint key, skip
      }
    }

    // ── Phase 2: Batch fetch CLMM PDAs + CP vaults ──────────────────────────
    const phase2Addresses = [
      ...clmmPdaEntries.map((e) => e.pda),
      ...cpVaultAddresses,
      ...ammV4VaultAddresses,
    ]

    if (
      phase2Addresses.length === 0 &&
      cpMatches.length === 0 &&
      ammV4Matches.length === 0
    )
      return []

    const phase2Map = phase2Addresses.length > 0 ? yield phase2Addresses : {}

    // Decode CLMM PersonalPositionState accounts
    interface ClmmPosition {
      poolId: string
      tickLower: number
      tickUpper: number
      liquidity: bigint
    }

    const clmmPositions: ClmmPosition[] = []
    const uniquePoolIds = new Set<string>()

    for (const entry of clmmPdaEntries) {
      if (!userToken2022NftMints.has(entry.mint)) continue
      const acc = phase2Map[entry.pda]
      if (!acc?.exists) continue
      const buf = Buffer.from(acc.data)
      // Verify discriminator
      if (buf.length < 8 || !buf.slice(0, 8).equals(PERSONAL_POSITION_DISC))
        continue
      try {
        const decoded = clmmCoder.accounts.decode('PersonalPositionState', buf)
        const liquidity = BigInt(
          (decoded.liquidity as { toString(): string }).toString(),
        )
        if (liquidity === 0n) continue
        const poolId = (decoded.pool_id as PublicKey).toBase58()
        clmmPositions.push({
          poolId,
          tickLower: decoded.tick_lower_index as number,
          tickUpper: decoded.tick_upper_index as number,
          liquidity,
        })
        uniquePoolIds.add(poolId)
      } catch {
        // skip decode failures
      }
    }

    // ── Phase 3: Fetch CLMM pool states ──────────────────────────────────────
    const clmmPoolAddresses = [...uniquePoolIds]

    if (
      clmmPositions.length === 0 &&
      cpMatches.length === 0 &&
      ammV4Matches.length === 0
    )
      return []

    const phase3Map =
      clmmPoolAddresses.length > 0 ? yield clmmPoolAddresses : {}

    const result: UserDefiPosition[] = []

    // ── Build CLMM positions ─────────────────────────────────────────────────
    for (const pos of clmmPositions) {
      const poolAcc = phase3Map[pos.poolId]
      if (!poolAcc?.exists) continue
      const poolBuf = Buffer.from(poolAcc.data)
      if (poolBuf.length < 273) continue
      const pool = decodeClmmPool(poolBuf)

      const { amount0, amount1 } = computeClmmAmounts(
        pos.liquidity,
        pool.tickCurrent,
        pos.tickLower,
        pos.tickUpper,
        pool.sqrtPriceX64,
      )

      const currentPrice = sqrtPriceX64ToPrice(
        pool.sqrtPriceX64,
        pool.mintDecimals0,
        pool.mintDecimals1,
      )
      const lowerPrice = tickToPrice(
        pos.tickLower,
        pool.mintDecimals0,
        pool.mintDecimals1,
      )
      const upperPrice = tickToPrice(
        pos.tickUpper,
        pool.mintDecimals0,
        pool.mintDecimals1,
      )

      const token0Info = tokens.get(pool.tokenMint0)
      const token1Info = tokens.get(pool.tokenMint1)

      const usdValue0 =
        token0Info?.priceUsd !== undefined
          ? (Number(amount0) / 10 ** pool.mintDecimals0) * token0Info.priceUsd
          : undefined
      const usdValue1 =
        token1Info?.priceUsd !== undefined
          ? (Number(amount1) / 10 ** pool.mintDecimals1) * token1Info.priceUsd
          : undefined

      const usdValue =
        usdValue0 !== undefined && usdValue1 !== undefined
          ? (usdValue0 + usdValue1).toString()
          : usdValue0 !== undefined
            ? usdValue0.toString()
            : usdValue1 !== undefined
              ? usdValue1.toString()
              : undefined

      result.push({
        positionKind: 'liquidity',
        liquidityModel: 'concentrated-range',
        platformId: 'raydium',
        isActive:
          pos.tickLower <= pool.tickCurrent && pool.tickCurrent < pos.tickUpper,
        lowerPriceUsd: lowerPrice.toString(),
        upperPriceUsd: upperPrice.toString(),
        currentPriceUsd: currentPrice.toString(),
        ...(usdValue !== undefined && { usdValue }),
        poolTokens: [
          {
            amount: {
              token: pool.tokenMint0,
              amount: amount0.toString(),
              decimals: pool.mintDecimals0.toString(),
            },
            ...(token0Info?.priceUsd !== undefined && {
              priceUsd: token0Info.priceUsd.toString(),
            }),
            ...(usdValue0 !== undefined && { usdValue: usdValue0.toString() }),
          },
          {
            amount: {
              token: pool.tokenMint1,
              amount: amount1.toString(),
              decimals: pool.mintDecimals1.toString(),
            },
            ...(token1Info?.priceUsd !== undefined && {
              priceUsd: token1Info.priceUsd.toString(),
            }),
            ...(usdValue1 !== undefined && { usdValue: usdValue1.toString() }),
          },
        ],
        poolAddress: pos.poolId,
      } satisfies ConcentratedRangeLiquidityDefiPosition)
    }

    // ── Build CP swap positions ──────────────────────────────────────────────
    for (const cp of cpMatches) {
      const vault0Acc = phase2Map[cp.token0Vault]
      const vault1Acc = phase2Map[cp.token1Vault]
      if (!vault0Acc?.exists || !vault1Acc?.exists) continue

      const vault0Balance = readTokenAccountAmount(vault0Acc.data)
      const vault1Balance = readTokenAccountAmount(vault1Acc.data)
      if (vault0Balance === null || vault1Balance === null) continue
      const { amount0, amount1 } = computeCpUserAmounts({
        vault0Balance,
        vault1Balance,
        userLpAmount: cp.userLpAmount,
        lpSupply: cp.lpSupply,
        protocolFeesToken0: cp.protocolFeesToken0,
        protocolFeesToken1: cp.protocolFeesToken1,
        fundFeesToken0: cp.fundFeesToken0,
        fundFeesToken1: cp.fundFeesToken1,
        creatorFeesToken0: cp.creatorFeesToken0,
        creatorFeesToken1: cp.creatorFeesToken1,
      })

      const token0Info = tokens.get(cp.token0Mint)
      const token1Info = tokens.get(cp.token1Mint)

      const usdValue0 =
        token0Info?.priceUsd !== undefined
          ? (Number(amount0) / 10 ** cp.mintDecimals0) * token0Info.priceUsd
          : undefined
      const usdValue1 =
        token1Info?.priceUsd !== undefined
          ? (Number(amount1) / 10 ** cp.mintDecimals1) * token1Info.priceUsd
          : undefined

      const usdValue =
        usdValue0 !== undefined && usdValue1 !== undefined
          ? (usdValue0 + usdValue1).toString()
          : usdValue0 !== undefined
            ? usdValue0.toString()
            : usdValue1 !== undefined
              ? usdValue1.toString()
              : undefined

      result.push({
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        platformId: 'raydium',
        ...(usdValue !== undefined && { usdValue }),
        poolTokens: [
          {
            amount: {
              token: cp.token0Mint,
              amount: amount0.toString(),
              decimals: cp.mintDecimals0.toString(),
            },
            ...(token0Info?.priceUsd !== undefined && {
              priceUsd: token0Info.priceUsd.toString(),
            }),
            ...(usdValue0 !== undefined && { usdValue: usdValue0.toString() }),
          },
          {
            amount: {
              token: cp.token1Mint,
              amount: amount1.toString(),
              decimals: cp.mintDecimals1.toString(),
            },
            ...(token1Info?.priceUsd !== undefined && {
              priceUsd: token1Info.priceUsd.toString(),
            }),
            ...(usdValue1 !== undefined && { usdValue: usdValue1.toString() }),
          },
        ],
        lpTokenAmount: cp.userLpAmount.toString(),
        poolAddress: cp.poolAddress,
      } satisfies ConstantProductLiquidityDefiPosition)
    }

    // ── Build AMM v4 (legacy) positions ─────────────────────────────────────
    for (const amm of ammV4Matches) {
      const baseVaultAcc = phase2Map[amm.baseVault]
      const quoteVaultAcc = phase2Map[amm.quoteVault]
      if (!baseVaultAcc?.exists || !quoteVaultAcc?.exists) continue

      const baseVaultBalance = readTokenAccountAmount(baseVaultAcc.data)
      const quoteVaultBalance = readTokenAccountAmount(quoteVaultAcc.data)
      if (baseVaultBalance === null || quoteVaultBalance === null) continue

      const { amount0, amount1 } = computeAmmV4UserAmounts({
        baseVaultBalance,
        quoteVaultBalance,
        userLpAmount: amm.userLpAmount,
        lpReserve: amm.lpReserve,
        baseNeedTakePnl: amm.baseNeedTakePnl,
        quoteNeedTakePnl: amm.quoteNeedTakePnl,
      })

      const token0Info = tokens.get(amm.baseMint)
      const token1Info = tokens.get(amm.quoteMint)

      const usdValue0 =
        token0Info?.priceUsd !== undefined
          ? (Number(amount0) / 10 ** amm.baseDecimal) * token0Info.priceUsd
          : undefined
      const usdValue1 =
        token1Info?.priceUsd !== undefined
          ? (Number(amount1) / 10 ** amm.quoteDecimal) * token1Info.priceUsd
          : undefined

      const usdValue =
        usdValue0 !== undefined && usdValue1 !== undefined
          ? (usdValue0 + usdValue1).toString()
          : usdValue0 !== undefined
            ? usdValue0.toString()
            : usdValue1 !== undefined
              ? usdValue1.toString()
              : undefined

      result.push({
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        platformId: 'raydium',
        ...(usdValue !== undefined && { usdValue }),
        poolTokens: [
          {
            amount: {
              token: amm.baseMint,
              amount: amount0.toString(),
              decimals: amm.baseDecimal.toString(),
            },
            ...(token0Info?.priceUsd !== undefined && {
              priceUsd: token0Info.priceUsd.toString(),
            }),
            ...(usdValue0 !== undefined && { usdValue: usdValue0.toString() }),
          },
          {
            amount: {
              token: amm.quoteMint,
              amount: amount1.toString(),
              decimals: amm.quoteDecimal.toString(),
            },
            ...(token1Info?.priceUsd !== undefined && {
              priceUsd: token1Info.priceUsd.toString(),
            }),
            ...(usdValue1 !== undefined && { usdValue: usdValue1.toString() }),
          },
        ],
        lpTokenAmount: amm.userLpAmount.toString(),
        poolAddress: amm.poolAddress,
      } satisfies ConstantProductLiquidityDefiPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)

    return result
  },

  // getUsersFilter: async function* (): UsersFilterPlan {
  //   const discoveredAccounts = yield [
  //     {
  //       kind: 'getProgramAccounts' as const,
  //       programId: CP_PROGRAM_ID,
  //       cacheTtlMs: ONE_HOUR_IN_MS,
  //       filters: [
  //         {
  //           memcmp: {
  //             offset: 0,
  //             bytes: CP_POOL_DISC_B64,
  //             encoding: 'base64' as const,
  //           },
  //         },
  //       ],
  //     },
  //     {
  //       kind: 'getProgramAccounts' as const,
  //       programId: AMM_V4.toBase58(),
  //       cacheTtlMs: ONE_HOUR_IN_MS,
  //       filters: [{ dataSize: 752 }],
  //     },
  //     {
  //       kind: 'getProgramAccounts' as const,
  //       programId: CLMM_PROGRAM.toBase58(),
  //       cacheTtlMs: ONE_HOUR_IN_MS,
  //       filters: [
  //         {
  //           memcmp: {
  //             offset: 0,
  //             bytes: PERSONAL_POSITION_DISC_B64,
  //             encoding: 'base64' as const,
  //           },
  //         },
  //       ],
  //     },
  //   ]

  //   const discoveredMints = new Set<string>()

  //   for (const account of Object.values(discoveredAccounts)) {
  //     if (!account.exists) continue
  //     const data = Buffer.from(account.data)

  //     if (account.programAddress === CP_PROGRAM_ID) {
  //       if (data.length < 413) continue
  //       discoveredMints.add(decodeCpPool(data).lpMint)
  //       continue
  //     }

  //     if (account.programAddress === AMM_V4.toBase58()) {
  //       if (data.length < AMM_V4_LP_MINT_OFFSET + 32) continue
  //       discoveredMints.add(readPubkey(data, AMM_V4_LP_MINT_OFFSET))
  //       continue
  //     }

  //     if (account.programAddress !== CLMM_PROGRAM.toBase58()) continue

  //     try {
  //       const decoded = clmmCoder.accounts.decode(
  //         'PersonalPositionState',
  //         data,
  //       ) as { nft_mint: PublicKey }
  //       discoveredMints.add(decoded.nft_mint.toBase58())
  //     } catch {
  //       // skip decode failures
  //     }
  //   }

  //   return buildTokenHolderUsersFiltersByMints(discoveredMints)
  // },
}

export default raydiumIntegration
