import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type {
  ConcentratedRangeLiquidityDefiPosition,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'

const BYREAL_PROGRAM_ID = 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2'
const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const POSITION_SEED = Buffer.from('position')
const DEFAULT_PUBKEY = '11111111111111111111111111111111'
const Q64 = 1n << 64n

const POSITION_NFT_MINT_OFFSET = 9
const POSITION_POOL_OFFSET = 41
const POSITION_TICK_LOWER_OFFSET = 73
const POSITION_TICK_UPPER_OFFSET = 77
const POSITION_LIQUIDITY_OFFSET = 81
const POSITION_FEES_OWED_A_OFFSET = 129
const POSITION_FEES_OWED_B_OFFSET = 137
const POSITION_REWARD_OWED_0_OFFSET = 161
const POSITION_REWARD_OWED_1_OFFSET = 185
const POSITION_REWARD_OWED_2_OFFSET = 209
const POSITION_MIN_DATA_LEN = 217

const POOL_MINT_A_OFFSET = 73
const POOL_MINT_B_OFFSET = 105
const POOL_DECIMALS_A_OFFSET = 233
const POOL_DECIMALS_B_OFFSET = 234
const POOL_SQRT_PRICE_X64_OFFSET = 253
const POOL_TICK_CURRENT_OFFSET = 269
const POOL_MIN_DATA_LEN = 825

const POOL_REWARD_BASE_OFFSET = 397
const POOL_REWARD_SLOT_SIZE = 169
const POOL_REWARD_STATE_OFFSET = 0
const POOL_REWARD_MINT_OFFSET = 57
const POOL_REWARD_SLOT_COUNT = 3

type ParsedPosition = {
  address: string
  nftMint: string
  poolAddress: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  feesOwedA: bigint
  feesOwedB: bigint
  rewardsOwed: [bigint, bigint, bigint]
}

type ParsedPool = {
  address: string
  mintA: string
  mintB: string
  decimalsA: number
  decimalsB: number
  sqrtPriceX64: bigint
  tickCurrent: number
  rewardMints: Array<string | null>
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  BYREAL_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 32) return null
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function readI32LE(data: Uint8Array, offset: number): number | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 4) return null
  return buf.readInt32LE(offset)
}

function readU8(data: Uint8Array, offset: number): number | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 1) return null
  return buf.readUInt8(offset)
}

function readU64LE(data: Uint8Array, offset: number): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 8) return null
  return buf.readBigUInt64LE(offset)
}

function readU128LE(data: Uint8Array, offset: number): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 16) return null
  let out = 0n
  for (let i = 0; i < 16; i++) {
    out |= BigInt(buf[offset + i] ?? 0) << (8n * BigInt(i))
  }
  return out
}

function parseTokenAccountMint(data: Uint8Array): string | null {
  return readPubkey(data, TOKEN_ACCOUNT_MINT_OFFSET)
}

function parseTokenAccountAmount(data: Uint8Array): bigint | null {
  return readU64LE(data, TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function parsePositionAccount(
  address: string,
  data: Uint8Array,
): ParsedPosition | null {
  const buf = Buffer.from(data)
  if (buf.length < POSITION_MIN_DATA_LEN) return null

  const nftMint = readPubkey(buf, POSITION_NFT_MINT_OFFSET)
  const poolAddress = readPubkey(buf, POSITION_POOL_OFFSET)
  const tickLower = readI32LE(buf, POSITION_TICK_LOWER_OFFSET)
  const tickUpper = readI32LE(buf, POSITION_TICK_UPPER_OFFSET)
  const liquidity = readU128LE(buf, POSITION_LIQUIDITY_OFFSET)
  const feesOwedA = readU64LE(buf, POSITION_FEES_OWED_A_OFFSET)
  const feesOwedB = readU64LE(buf, POSITION_FEES_OWED_B_OFFSET)
  const reward0 = readU64LE(buf, POSITION_REWARD_OWED_0_OFFSET)
  const reward1 = readU64LE(buf, POSITION_REWARD_OWED_1_OFFSET)
  const reward2 = readU64LE(buf, POSITION_REWARD_OWED_2_OFFSET)

  if (
    !nftMint ||
    !poolAddress ||
    tickLower === null ||
    tickUpper === null ||
    liquidity === null ||
    feesOwedA === null ||
    feesOwedB === null ||
    reward0 === null ||
    reward1 === null ||
    reward2 === null
  ) {
    return null
  }

  return {
    address,
    nftMint,
    poolAddress,
    tickLower,
    tickUpper,
    liquidity,
    feesOwedA,
    feesOwedB,
    rewardsOwed: [reward0, reward1, reward2],
  }
}

function parsePoolAccount(
  address: string,
  data: Uint8Array,
): ParsedPool | null {
  const buf = Buffer.from(data)
  if (buf.length < POOL_MIN_DATA_LEN) return null

  const mintA = readPubkey(buf, POOL_MINT_A_OFFSET)
  const mintB = readPubkey(buf, POOL_MINT_B_OFFSET)
  const decimalsA = readU8(buf, POOL_DECIMALS_A_OFFSET)
  const decimalsB = readU8(buf, POOL_DECIMALS_B_OFFSET)
  const sqrtPriceX64 = readU128LE(buf, POOL_SQRT_PRICE_X64_OFFSET)
  const tickCurrent = readI32LE(buf, POOL_TICK_CURRENT_OFFSET)

  if (
    !mintA ||
    !mintB ||
    decimalsA === null ||
    decimalsB === null ||
    sqrtPriceX64 === null ||
    tickCurrent === null
  ) {
    return null
  }

  const rewardMints: Array<string | null> = []
  for (let index = 0; index < POOL_REWARD_SLOT_COUNT; index++) {
    const baseOffset = POOL_REWARD_BASE_OFFSET + index * POOL_REWARD_SLOT_SIZE
    const state = readU8(buf, baseOffset + POOL_REWARD_STATE_OFFSET)
    const mint = readPubkey(buf, baseOffset + POOL_REWARD_MINT_OFFSET)

    if (state === null || state === 0 || !mint || mint === DEFAULT_PUBKEY) {
      rewardMints.push(null)
      continue
    }

    rewardMints.push(mint)
  }

  return {
    address,
    mintA,
    mintB,
    decimalsA,
    decimalsB,
    sqrtPriceX64,
    tickCurrent,
    rewardMints,
  }
}

function priceFromTick(
  tick: number,
  decimalsA: number,
  decimalsB: number,
): number | null {
  const price = 1.0001 ** tick * 10 ** (decimalsA - decimalsB)
  if (!Number.isFinite(price) || price <= 0) return null
  return price
}

function sqrtPriceX64FromTickApprox(
  tick: number,
  decimalsA: number,
  decimalsB: number,
): bigint | null {
  const price = priceFromTick(tick, decimalsA, decimalsB)
  if (!price) return null

  const sqrtPrice = Math.sqrt(price)
  if (!Number.isFinite(sqrtPrice) || sqrtPrice <= 0) return null

  const scaled = sqrtPrice * 2 ** 64
  if (!Number.isFinite(scaled) || scaled <= 0) return null
  return BigInt(Math.floor(scaled))
}

function mulDivFloor(
  value: bigint,
  multiplier: bigint,
  divisor: bigint,
): bigint {
  if (value <= 0n || multiplier <= 0n || divisor <= 0n) return 0n
  return (value * multiplier) / divisor
}

function computeTokenAmountsFromLiquidity(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  currentSqrtPriceX64: bigint,
  decimalsA: number,
  decimalsB: number,
): { amountA: bigint; amountB: bigint } {
  if (liquidity <= 0n) return { amountA: 0n, amountB: 0n }

  const sqrtLower = sqrtPriceX64FromTickApprox(tickLower, decimalsA, decimalsB)
  const sqrtUpper = sqrtPriceX64FromTickApprox(tickUpper, decimalsA, decimalsB)
  if (!sqrtLower || !sqrtUpper || sqrtLower <= 0n || sqrtUpper <= 0n) {
    return { amountA: 0n, amountB: 0n }
  }

  const lower = sqrtLower < sqrtUpper ? sqrtLower : sqrtUpper
  const upper = sqrtLower < sqrtUpper ? sqrtUpper : sqrtLower
  const current = currentSqrtPriceX64

  if (current <= lower) {
    const numerator = liquidity * (upper - lower) * Q64
    const denominator = upper * lower
    return {
      amountA: denominator > 0n ? numerator / denominator : 0n,
      amountB: 0n,
    }
  }

  if (current < upper) {
    const numeratorA = liquidity * (upper - current) * Q64
    const denominatorA = upper * current
    const amountA = denominatorA > 0n ? numeratorA / denominatorA : 0n
    const amountB = mulDivFloor(liquidity, current - lower, Q64)
    return { amountA, amountB }
  }

  return {
    amountA: 0n,
    amountB: mulDivFloor(liquidity, upper - lower, Q64),
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
  mint: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const usdValue = buildUsdValue(amountRaw, decimals, priceUsd)
  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function sumUsd(values: PositionValue[]): string | undefined {
  const numbers = values
    .map((item) => item.usdValue)
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter((value) => Number.isFinite(value))

  if (numbers.length === 0) return undefined
  return numbers.reduce((sum, value) => sum + value, 0).toString()
}

export const byrealIntegration: SolanaIntegration = {
  platformId: 'byreal',

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
    const byrealProgramKey = new PublicKey(BYREAL_PROGRAM_ID)

    const ownedTokenAccounts = yield [
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

    const nftMints = new Set<string>()
    for (const account of Object.values(ownedTokenAccounts)) {
      if (!account.exists) continue
      const mint = parseTokenAccountMint(account.data)
      const amount = parseTokenAccountAmount(account.data)
      if (!mint || amount !== 1n) continue
      nftMints.add(mint)
    }

    if (nftMints.size === 0) return []

    const positionAddresses = [...nftMints].map((mint) =>
      PublicKey.findProgramAddressSync(
        [POSITION_SEED, new PublicKey(mint).toBuffer()],
        byrealProgramKey,
      )[0].toBase58(),
    )

    const positionMap = yield positionAddresses

    const positions: ParsedPosition[] = []
    const poolAddressSet = new Set<string>()

    for (const [positionAddress, account] of Object.entries(positionMap)) {
      if (!account.exists) continue
      if (account.programAddress !== BYREAL_PROGRAM_ID) continue

      const parsed = parsePositionAccount(positionAddress, account.data)
      if (!parsed) continue

      positions.push(parsed)
      poolAddressSet.add(parsed.poolAddress)
    }

    if (positions.length === 0) return []

    const poolAddresses = [...poolAddressSet]
    const poolAccountsMap = yield poolAddresses
    const poolsByAddress = new Map<string, ParsedPool>()

    for (const poolAddress of poolAddresses) {
      const account = poolAccountsMap[poolAddress]
      if (!account?.exists) continue
      if (account.programAddress !== BYREAL_PROGRAM_ID) continue

      const parsed = parsePoolAccount(poolAddress, account.data)
      if (!parsed) continue
      poolsByAddress.set(poolAddress, parsed)
    }

    const result: UserDefiPosition[] = []

    for (const position of positions) {
      const pool = poolsByAddress.get(position.poolAddress)
      if (!pool) continue

      const lowerPrice = priceFromTick(
        position.tickLower,
        pool.decimalsA,
        pool.decimalsB,
      )
      const upperPrice = priceFromTick(
        position.tickUpper,
        pool.decimalsA,
        pool.decimalsB,
      )
      const currentPrice = priceFromTick(
        pool.tickCurrent,
        pool.decimalsA,
        pool.decimalsB,
      )
      if (!lowerPrice || !upperPrice || !currentPrice) continue

      const amounts = computeTokenAmountsFromLiquidity(
        position.liquidity,
        position.tickLower,
        position.tickUpper,
        pool.sqrtPriceX64,
        pool.decimalsA,
        pool.decimalsB,
      )

      const tokenPriceA = tokens.get(pool.mintA)?.priceUsd
      const tokenPriceB = tokens.get(pool.mintB)?.priceUsd

      const poolTokens = [
        buildPositionValue(
          pool.mintA,
          amounts.amountA,
          pool.decimalsA,
          tokenPriceA,
        ),
        buildPositionValue(
          pool.mintB,
          amounts.amountB,
          pool.decimalsB,
          tokenPriceB,
        ),
      ]

      const fees: PositionValue[] = []
      if (position.feesOwedA > 0n) {
        fees.push(
          buildPositionValue(
            pool.mintA,
            position.feesOwedA,
            pool.decimalsA,
            tokenPriceA,
          ),
        )
      }
      if (position.feesOwedB > 0n) {
        fees.push(
          buildPositionValue(
            pool.mintB,
            position.feesOwedB,
            pool.decimalsB,
            tokenPriceB,
          ),
        )
      }

      const rewards: PositionValue[] = []
      for (let index = 0; index < position.rewardsOwed.length; index++) {
        const amountRaw = position.rewardsOwed[index]
        if (!amountRaw || amountRaw <= 0n) continue

        const rewardMint = pool.rewardMints[index]
        if (!rewardMint) continue

        const rewardDecimals = tokens.get(rewardMint)?.decimals ?? 0
        const rewardPrice = tokens.get(rewardMint)?.priceUsd
        rewards.push(
          buildPositionValue(
            rewardMint,
            amountRaw,
            rewardDecimals,
            rewardPrice,
          ),
        )
      }

      const usdValue = sumUsd(poolTokens)

      result.push({
        positionKind: 'liquidity',
        liquidityModel: 'concentrated-range',
        platformId: 'byreal',
        isActive:
          position.tickLower <= pool.tickCurrent &&
          pool.tickCurrent <= position.tickUpper,
        lowerPriceUsd: lowerPrice.toString(),
        upperPriceUsd: upperPrice.toString(),
        currentPriceUsd: currentPrice.toString(),
        ...(usdValue !== undefined && { usdValue }),
        poolTokens,
        ...(fees.length > 0 && { fees }),
        ...(rewards.length > 0 && { rewards }),
        poolAddress: pool.address,
        meta: {
          byreal: {
            positionAddress: position.address,
            nftMint: position.nftMint,
            liquidity: position.liquidity.toString(),
          },
        },
      } satisfies ConcentratedRangeLiquidityDefiPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)
    return result
  },

  // Byreal position accounts are NFT-based and do not store a wallet pubkey.
  getUsersFilter: (): UsersFilterSource => [],
}

export default byrealIntegration
