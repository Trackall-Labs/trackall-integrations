import { BorshCoder } from '@coral-xyz/anchor'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type {
  ConcentratedRangeLiquidityDefiPosition,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  // UsersFilter,
  // UsersFilterPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'
import clmmIdl from '../raydium/idls/amm_v3.json'

const PANCAKESWAP_CLMM_PROGRAM_ID =
  'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const CLMM_PROGRAM = new PublicKey(PANCAKESWAP_CLMM_PROGRAM_ID)

export const PROGRAM_IDS = [
  CLMM_PROGRAM.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const
// const ONE_HOUR_IN_MS = 60 * 60 * 1000

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
const TOKEN_ACCOUNT_MINT_OFFSET = 0
// const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
// const PERSONAL_POSITION_NFT_MINT_OFFSET = 9

const clmmCoder = new BorshCoder(clmmIdl as never)

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.slice(offset, offset + 32)).toBase58()
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

function readTokenAccountMint(data: Uint8Array): string | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_MINT_OFFSET + 32) return null
  return readPubkey(buf, TOKEN_ACCOUNT_MINT_OFFSET)
}

function readTokenAccountAmount(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return null
  return buf.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

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

const Q64 = 1n << 64n

function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = 1.0001 ** (tick / 2)
  return BigInt(Math.round(sqrtPrice * Number(Q64)))
}

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
    amount0 =
      (liquidity * Q64 * (sqrtPriceUpperX64 - sqrtPriceLowerX64)) /
      (sqrtPriceLowerX64 * sqrtPriceUpperX64)
  } else if (tickCurrent >= tickUpper) {
    amount1 = (liquidity * (sqrtPriceUpperX64 - sqrtPriceLowerX64)) / Q64
  } else {
    amount0 =
      (liquidity * Q64 * (sqrtPriceUpperX64 - sqrtPriceX64)) /
      (sqrtPriceX64 * sqrtPriceUpperX64)
    amount1 = (liquidity * (sqrtPriceX64 - sqrtPriceLowerX64)) / Q64
  }

  return { amount0, amount1 }
}

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

function subU128(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : U128_MOD - (b - a)
}

function mulDivFloor(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n
  return (a * b) / denominator
}

function toBigInt(value: { toString(): string }): bigint {
  return BigInt(value.toString())
}

function i32ToLeBuffer(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeInt32LE(value, 0)
  return buf
}

function getTickArrayStartIndex(
  tickIndex: number,
  tickSpacing: number,
): number {
  const ticksInArray = tickSpacing * TICK_ARRAY_SIZE
  return Math.floor(tickIndex / ticksInArray) * ticksInArray
}

function getTickArrayAddress(poolId: string, startIndex: number): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('tick_array'),
      new PublicKey(poolId).toBuffer(),
      i32ToLeBuffer(startIndex),
    ],
    CLMM_PROGRAM,
  )
  return pda.toBase58()
}

function parseTickStateForTick(
  accountData: Uint8Array | undefined,
  tickIndex: number,
  tickSpacing: number,
): TickStateQuote | null {
  if (!accountData) return null

  try {
    const decoded = clmmCoder.accounts.decode(
      'TickArrayState',
      Buffer.from(accountData),
    ) as {
      start_tick_index: number
      ticks: Array<{
        tick: number
        fee_growth_outside_0_x64: { toString(): string }
        fee_growth_outside_1_x64: { toString(): string }
      }>
    }

    const offset = tickIndex - decoded.start_tick_index
    if (offset % tickSpacing !== 0) return null

    const arrayIndex = offset / tickSpacing
    if (arrayIndex < 0 || arrayIndex >= TICK_ARRAY_SIZE) return null

    const tick = decoded.ticks[arrayIndex]
    if (!tick || tick.tick !== tickIndex) return null

    return {
      feeGrowthOutside0X64: toBigInt(tick.fee_growth_outside_0_x64),
      feeGrowthOutside1X64: toBigInt(tick.fee_growth_outside_1_x64),
    }
  } catch {
    return null
  }
}

function quoteUncollectedFees(params: {
  liquidity: bigint
  tickLower: number
  tickUpper: number
  tickCurrent: number
  lpFeeRate: bigint
  feeGrowthGlobal0X64: bigint
  feeGrowthGlobal1X64: bigint
  feeGrowthInside0LastX64: bigint
  feeGrowthInside1LastX64: bigint
  tokenFeesOwed0: bigint
  tokenFeesOwed1: bigint
  lowerTickState: TickStateQuote | null
  upperTickState: TickStateQuote | null
}): { fee0: bigint; fee1: bigint } {
  const {
    liquidity,
    tickLower,
    tickUpper,
    tickCurrent,
    lpFeeRate,
    feeGrowthGlobal0X64,
    feeGrowthGlobal1X64,
    feeGrowthInside0LastX64,
    feeGrowthInside1LastX64,
    tokenFeesOwed0,
    tokenFeesOwed1,
    lowerTickState,
    upperTickState,
  } = params

  const lowerOutside0 = lowerTickState?.feeGrowthOutside0X64 ?? 0n
  const lowerOutside1 = lowerTickState?.feeGrowthOutside1X64 ?? 0n
  const upperOutside0 = upperTickState?.feeGrowthOutside0X64 ?? 0n
  const upperOutside1 = upperTickState?.feeGrowthOutside1X64 ?? 0n

  const feeGrowthBelow0 =
    tickCurrent >= tickLower
      ? lowerOutside0
      : subU128(feeGrowthGlobal0X64, lowerOutside0)
  const feeGrowthBelow1 =
    tickCurrent >= tickLower
      ? lowerOutside1
      : subU128(feeGrowthGlobal1X64, lowerOutside1)

  const feeGrowthAbove0 =
    tickCurrent < tickUpper
      ? upperOutside0
      : subU128(feeGrowthGlobal0X64, upperOutside0)
  const feeGrowthAbove1 =
    tickCurrent < tickUpper
      ? upperOutside1
      : subU128(feeGrowthGlobal1X64, upperOutside1)

  const feeGrowthInside0 = subU128(
    subU128(feeGrowthGlobal0X64, feeGrowthBelow0),
    feeGrowthAbove0,
  )
  const feeGrowthInside1 = subU128(
    subU128(feeGrowthGlobal1X64, feeGrowthBelow1),
    feeGrowthAbove1,
  )

  const feeDelta0 = mulDivFloor(
    liquidity,
    subU128(feeGrowthInside0, feeGrowthInside0LastX64),
    Q64,
  )
  const feeDelta1 = mulDivFloor(
    liquidity,
    subU128(feeGrowthInside1, feeGrowthInside1LastX64),
    Q64,
  )
  const feeDelta0Net = mulDivFloor(feeDelta0, lpFeeRate, FEE_RATE_DENOMINATOR)
  const feeDelta1Net = mulDivFloor(feeDelta1, lpFeeRate, FEE_RATE_DENOMINATOR)

  return {
    fee0: tokenFeesOwed0 + feeDelta0Net,
    fee1: tokenFeesOwed1 + feeDelta1Net,
  }
}

type ClmmPosition = {
  poolId: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  feeGrowthInside0LastX64: bigint
  feeGrowthInside1LastX64: bigint
  tokenFeesOwed0: bigint
  tokenFeesOwed1: bigint
}

type TickStateQuote = {
  feeGrowthOutside0X64: bigint
  feeGrowthOutside1X64: bigint
}

const U128_MOD = 1n << 128n
const TICK_ARRAY_SIZE = 60
const FEE_RATE_DENOMINATOR = 1_000_000n

function buildPositionValue(
  token: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const amountUi = Number(amountRaw) / 10 ** decimals
  const usdValue =
    priceUsd === undefined ? undefined : (amountUi * priceUsd).toString()

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

function sumUsdValues(values: PositionValue[]): string | undefined {
  if (values.length === 0) return '0'

  let total = 0
  for (const value of values) {
    if (value.usdValue === undefined) return undefined
    total += Number(value.usdValue)
  }

  return total.toString()
}

// function buildTokenHolderUsersFiltersByMints(
//   mints: Iterable<string>,
// ): UsersFilter[] {
//   const filters: UsersFilter[] = []
//   const tokenProgramId = TOKEN_PROGRAM_ID.toBase58()
//   const token2022ProgramId = TOKEN_2022_PROGRAM_ID.toBase58()
//
//   for (const mint of new Set(mints)) {
//     let mintBytes: Uint8Array
//     try {
//       mintBytes = new PublicKey(mint).toBytes()
//     } catch {
//       continue
//     }
//
//     filters.push({
//       programId: tokenProgramId,
//       ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
//       memcmps: [{ offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mintBytes }],
//     })
//     filters.push({
//       programId: token2022ProgramId,
//       ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
//       memcmps: [{ offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mintBytes }],
//     })
//   }
//
//   return filters
// }

export const pancakeswapIntegration: SolanaIntegration = {
  platformId: 'pancakeswap',

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

    const phase0Map = yield [
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

    const userTokenMints = new Set<string>()
    for (const account of Object.values(phase0Map)) {
      if (!account.exists) continue
      if (
        account.programAddress !== TOKEN_PROGRAM_ID.toBase58() &&
        account.programAddress !== TOKEN_2022_PROGRAM_ID.toBase58()
      ) {
        continue
      }

      const mint = readTokenAccountMint(account.data)
      const amount = readTokenAccountAmount(account.data)
      if (!mint || amount === null || amount === 0n) continue
      userTokenMints.add(mint)
    }

    if (userTokenMints.size === 0) return []

    const clmmPdaEntries: { mint: string; pda: string }[] = []
    for (const mint of userTokenMints) {
      try {
        const mintPubkey = new PublicKey(mint)
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('position'), mintPubkey.toBuffer()],
          CLMM_PROGRAM,
        )
        clmmPdaEntries.push({ mint, pda: pda.toBase58() })
      } catch {}
    }

    if (clmmPdaEntries.length === 0) return []

    const phase1Map = yield clmmPdaEntries.map((entry) => entry.pda)

    const clmmPositions: ClmmPosition[] = []
    const uniquePoolIds = new Set<string>()

    for (const entry of clmmPdaEntries) {
      const acc = phase1Map[entry.pda]
      if (!acc?.exists) continue
      if (acc.programAddress !== CLMM_PROGRAM.toBase58()) continue

      const buf = Buffer.from(acc.data)
      if (buf.length < 8 || !buf.slice(0, 8).equals(PERSONAL_POSITION_DISC))
        continue

      try {
        const decoded = clmmCoder.accounts.decode(
          'PersonalPositionState',
          buf,
        ) as {
          pool_id: PublicKey
          tick_lower_index: number
          tick_upper_index: number
          liquidity: { toString(): string }
          fee_growth_inside_0_last_x64: { toString(): string }
          fee_growth_inside_1_last_x64: { toString(): string }
          token_fees_owed_0: { toString(): string }
          token_fees_owed_1: { toString(): string }
        }
        const liquidity = BigInt(decoded.liquidity.toString())
        if (liquidity === 0n) continue

        const poolId = decoded.pool_id.toBase58()
        clmmPositions.push({
          poolId,
          tickLower: decoded.tick_lower_index,
          tickUpper: decoded.tick_upper_index,
          liquidity,
          feeGrowthInside0LastX64: BigInt(
            decoded.fee_growth_inside_0_last_x64.toString(),
          ),
          feeGrowthInside1LastX64: BigInt(
            decoded.fee_growth_inside_1_last_x64.toString(),
          ),
          tokenFeesOwed0: BigInt(decoded.token_fees_owed_0.toString()),
          tokenFeesOwed1: BigInt(decoded.token_fees_owed_1.toString()),
        })
        uniquePoolIds.add(poolId)
      } catch {}
    }

    if (clmmPositions.length === 0) return []

    const phase2Map = yield [...uniquePoolIds]
    const poolStateByPoolId = new Map<
      string,
      {
        feeGrowthGlobal0X64: bigint
        feeGrowthGlobal1X64: bigint
        ammConfig: string
      }
    >()
    const ammConfigAddresses = new Set<string>()
    const tickArraysByPosition = new Map<
      number,
      { lowerTickArrayAddress: string; upperTickArrayAddress: string }
    >()
    const tickArrayAddresses = new Set<string>()

    for (const [index, position] of clmmPositions.entries()) {
      const poolAcc = phase2Map[position.poolId]
      if (!poolAcc?.exists) continue

      const poolState = clmmCoder.accounts.decode(
        'PoolState',
        Buffer.from(poolAcc.data),
      ) as {
        amm_config: PublicKey
        fee_growth_global_0_x64: { toString(): string }
        fee_growth_global_1_x64: { toString(): string }
      }
      poolStateByPoolId.set(position.poolId, {
        ammConfig: poolState.amm_config.toBase58(),
        feeGrowthGlobal0X64: toBigInt(poolState.fee_growth_global_0_x64),
        feeGrowthGlobal1X64: toBigInt(poolState.fee_growth_global_1_x64),
      })
      ammConfigAddresses.add(poolState.amm_config.toBase58())

      const pool = decodeClmmPool(Buffer.from(poolAcc.data))
      const lowerStart = getTickArrayStartIndex(
        position.tickLower,
        pool.tickSpacing,
      )
      const upperStart = getTickArrayStartIndex(
        position.tickUpper,
        pool.tickSpacing,
      )

      const lowerTickArrayAddress = getTickArrayAddress(
        position.poolId,
        lowerStart,
      )
      const upperTickArrayAddress = getTickArrayAddress(
        position.poolId,
        upperStart,
      )

      tickArraysByPosition.set(index, {
        lowerTickArrayAddress,
        upperTickArrayAddress,
      })
      tickArrayAddresses.add(lowerTickArrayAddress)
      tickArrayAddresses.add(upperTickArrayAddress)
    }

    const phase3Addresses = [
      ...new Set([...tickArrayAddresses, ...ammConfigAddresses]),
    ]
    const phase3Map = phase3Addresses.length > 0 ? yield phase3Addresses : {}

    const lpFeeRateByConfigAddress = new Map<string, bigint>()
    for (const configAddress of ammConfigAddresses) {
      const configAccount = phase3Map[configAddress]
      if (!configAccount?.exists) continue
      if (configAccount.programAddress !== CLMM_PROGRAM.toBase58()) continue

      try {
        const config = clmmCoder.accounts.decode(
          'AmmConfig',
          Buffer.from(configAccount.data),
        ) as {
          protocol_fee_rate: number
          fund_fee_rate: number
        }
        const protocolFeeRate = BigInt(config.protocol_fee_rate)
        const fundFeeRate = BigInt(config.fund_fee_rate)
        const lpFeeRate = FEE_RATE_DENOMINATOR - protocolFeeRate - fundFeeRate
        lpFeeRateByConfigAddress.set(
          configAddress,
          lpFeeRate > 0n ? lpFeeRate : 0n,
        )
      } catch {}
    }

    const positions: UserDefiPosition[] = []

    for (const [index, position] of clmmPositions.entries()) {
      const poolAcc = phase2Map[position.poolId]
      if (!poolAcc?.exists) continue
      if (poolAcc.programAddress !== CLMM_PROGRAM.toBase58()) continue

      const poolBuf = Buffer.from(poolAcc.data)
      if (poolBuf.length < 273) continue
      const pool = decodeClmmPool(poolBuf)
      const poolState = poolStateByPoolId.get(position.poolId)
      if (!poolState) continue
      const lpFeeRate =
        lpFeeRateByConfigAddress.get(poolState.ammConfig) ??
        FEE_RATE_DENOMINATOR

      const tickArrayAddressesForPosition = tickArraysByPosition.get(index)
      const lowerTickArrayAccount = tickArrayAddressesForPosition
        ? phase3Map[tickArrayAddressesForPosition.lowerTickArrayAddress]
        : undefined
      const upperTickArrayAccount = tickArrayAddressesForPosition
        ? phase3Map[tickArrayAddressesForPosition.upperTickArrayAddress]
        : undefined
      const lowerTickState = tickArrayAddressesForPosition
        ? parseTickStateForTick(
            lowerTickArrayAccount?.exists
              ? lowerTickArrayAccount.data
              : undefined,
            position.tickLower,
            pool.tickSpacing,
          )
        : null
      const upperTickState = tickArrayAddressesForPosition
        ? parseTickStateForTick(
            upperTickArrayAccount?.exists
              ? upperTickArrayAccount.data
              : undefined,
            position.tickUpper,
            pool.tickSpacing,
          )
        : null

      const { amount0, amount1 } = computeClmmAmounts(
        position.liquidity,
        pool.tickCurrent,
        position.tickLower,
        position.tickUpper,
        pool.sqrtPriceX64,
      )

      const currentPrice = sqrtPriceX64ToPrice(
        pool.sqrtPriceX64,
        pool.mintDecimals0,
        pool.mintDecimals1,
      )
      const lowerPrice = tickToPrice(
        position.tickLower,
        pool.mintDecimals0,
        pool.mintDecimals1,
      )
      const upperPrice = tickToPrice(
        position.tickUpper,
        pool.mintDecimals0,
        pool.mintDecimals1,
      )

      const token0Info = tokens.get(pool.tokenMint0)
      const token1Info = tokens.get(pool.tokenMint1)
      const quotedFees = quoteUncollectedFees({
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        tickCurrent: pool.tickCurrent,
        lpFeeRate,
        feeGrowthGlobal0X64: poolState.feeGrowthGlobal0X64,
        feeGrowthGlobal1X64: poolState.feeGrowthGlobal1X64,
        feeGrowthInside0LastX64: position.feeGrowthInside0LastX64,
        feeGrowthInside1LastX64: position.feeGrowthInside1LastX64,
        tokenFeesOwed0: position.tokenFeesOwed0,
        tokenFeesOwed1: position.tokenFeesOwed1,
        lowerTickState,
        upperTickState,
      })

      const poolTokens = [
        buildPositionValue(
          pool.tokenMint0,
          amount0,
          pool.mintDecimals0,
          token0Info?.priceUsd,
        ),
        buildPositionValue(
          pool.tokenMint1,
          amount1,
          pool.mintDecimals1,
          token1Info?.priceUsd,
        ),
      ]

      const fees = [
        quotedFees.fee0 > 0n
          ? buildPositionValue(
              pool.tokenMint0,
              quotedFees.fee0,
              pool.mintDecimals0,
              token0Info?.priceUsd,
            )
          : null,
        quotedFees.fee1 > 0n
          ? buildPositionValue(
              pool.tokenMint1,
              quotedFees.fee1,
              pool.mintDecimals1,
              token1Info?.priceUsd,
            )
          : null,
      ].filter((item): item is PositionValue => item !== null)

      const usdValue = sumUsdValues([...poolTokens, ...fees])

      positions.push({
        positionKind: 'liquidity',
        liquidityModel: 'concentrated-range',
        platformId: 'pancakeswap',
        isActive:
          position.tickLower <= pool.tickCurrent &&
          pool.tickCurrent < position.tickUpper,
        lowerPriceUsd: lowerPrice.toString(),
        upperPriceUsd: upperPrice.toString(),
        currentPriceUsd: currentPrice.toString(),
        ...(usdValue !== undefined && { usdValue }),
        poolTokens,
        ...(fees.length > 0 && { fees }),
        poolAddress: position.poolId,
      } satisfies ConcentratedRangeLiquidityDefiPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  // getUsersFilter: async function* (): UsersFilterPlan {
  //   const positionAccounts = yield {
  //     kind: 'getProgramAccounts' as const,
  //     programId: CLMM_PROGRAM.toBase58(),
  //     cacheTtlMs: ONE_HOUR_IN_MS,
  //     filters: [
  //       {
  //         memcmp: {
  //           offset: 0,
  //           bytes: PERSONAL_POSITION_DISC_B64,
  //           encoding: 'base64',
  //         },
  //       },
  //     ],
  //   }

  //   const discoveredPositionNftMints = new Set<string>()
  //   for (const account of Object.values(positionAccounts)) {
  //     if (!account.exists) continue
  //     if (account.programAddress !== CLMM_PROGRAM.toBase58()) continue

  //     const buf = Buffer.from(account.data)
  //     if (buf.length < PERSONAL_POSITION_NFT_MINT_OFFSET + 32) continue
  //     if (!buf.subarray(0, 8).equals(PERSONAL_POSITION_DISC)) continue

  //     discoveredPositionNftMints.add(
  //       readPubkey(buf, PERSONAL_POSITION_NFT_MINT_OFFSET),
  //     )
  //   }

  //   return buildTokenHolderUsersFiltersByMints(discoveredPositionNftMints)
  // },
}

export default pancakeswapIntegration
