import { BN } from '@coral-xyz/anchor'
import type {
  PositionBundleData,
  PositionData,
  TickArrayData,
  WhirlpoolData,
} from '@orca-so/whirlpools-sdk'
import {
  // AccountName,
  collectFeesQuote,
  collectRewardsQuote,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  ParsablePosition,
  ParsablePositionBundle,
  ParsableTickArray,
  ParsableWhirlpool,
  PDAUtil,
  PoolUtil,
  PositionBundleUtil,
  PriceMath,
  TickArrayUtil,
  // WHIRLPOOL_CODER,
} from '@orca-so/whirlpools-sdk'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import type {
  ConcentratedRangeLiquidityDefiPosition,
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
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'

type ParsedMintAccount = ReturnType<typeof unpackMint> & {
  tokenProgram: PublicKey
}

type ClockState = {
  epoch: number
  unixTimestamp: BN
}

export const testAddress = '93PSyNrS7zBhrXaHHfU1ZtfegcKq5SaCYc35ZwPVrK3K'

export const PROGRAM_IDS = [
  ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

const TOKEN_ACCOUNT_MINT_OFFSET = 0
// const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
// const ONE_HOUR_IN_MS = 60 * 60 * 1000

// const POSITION_DISC_B64 = Buffer.from(
//   WHIRLPOOL_CODER.accountDiscriminator(AccountName.Position),
// ).toString('base64')
// const POSITION_BUNDLE_DISC_B64 = Buffer.from(
//   WHIRLPOOL_CODER.accountDiscriminator(AccountName.PositionBundle),
// ).toString('base64')

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
  return buf.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET)
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

function parsePosition(
  address: string,
  account: MaybeSolanaAccount | undefined,
): PositionData | null {
  return ParsablePosition.parse(new PublicKey(address), toAccountInfo(account))
}

function parsePositionBundle(
  address: string,
  account: MaybeSolanaAccount | undefined,
): PositionBundleData | null {
  return ParsablePositionBundle.parse(
    new PublicKey(address),
    toAccountInfo(account),
  )
}

function parseWhirlpool(
  address: string,
  account: MaybeSolanaAccount | undefined,
): WhirlpoolData | null {
  return ParsableWhirlpool.parse(new PublicKey(address), toAccountInfo(account))
}

function parseTickArray(
  address: string,
  account: MaybeSolanaAccount | undefined,
): TickArrayData | null {
  return ParsableTickArray.parse(new PublicKey(address), toAccountInfo(account))
}

function parseMint(
  address: string,
  account: MaybeSolanaAccount | undefined,
): ParsedMintAccount | null {
  const accountInfo = toAccountInfo(account)
  if (!accountInfo) return null

  try {
    return {
      ...unpackMint(new PublicKey(address), accountInfo, accountInfo.owner),
      tokenProgram: accountInfo.owner,
    }
  } catch {
    return null
  }
}

function parseClock(
  account: MaybeSolanaAccount | undefined,
): ClockState | null {
  if (!account?.exists) return null

  const buf = Buffer.from(account.data)
  if (buf.length < 40) return null

  return {
    epoch: Number(buf.readBigUInt64LE(16)),
    unixTimestamp: new BN(buf.readBigInt64LE(32).toString()),
  }
}

function buildPositionValue(
  token: string,
  amountRaw: BN | bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const raw =
    typeof amountRaw === 'bigint' ? amountRaw : BigInt(amountRaw.toString())
  const amountUi = Number(raw) / 10 ** decimals
  const usdValue =
    priceUsd === undefined ? undefined : (amountUi * priceUsd).toString()

  return {
    amount: {
      token,
      amount: raw.toString(),
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

function divideToDecimalString(
  numerator: bigint,
  denominator: bigint,
  digits = 4,
): string {
  if (denominator === 0n) return '0'

  const integerPart = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return integerPart.toString()

  const scale = 10n ** BigInt(digits)
  const fraction = ((remainder * scale) / denominator)
    .toString()
    .padStart(digits, '0')
    .replace(/0+$/, '')

  return fraction.length === 0
    ? integerPart.toString()
    : `${integerPart}.${fraction}`
}

function collectCandidateMints(accounts: MaybeSolanaAccount[]): {
  positionMints: Set<string>
  bundleMints: Set<string>
} {
  const positionMints = new Set<string>()
  const bundleMints = new Set<string>()
  const tokenProgramId = TOKEN_PROGRAM_ID.toBase58()
  const token2022ProgramId = TOKEN_2022_PROGRAM_ID.toBase58()

  for (const account of accounts) {
    if (!account.exists) continue
    const mint = readTokenAccountMint(account.data)
    if (!mint) continue

    if (account.programAddress === token2022ProgramId) {
      const amount = readTokenAccountAmount(account.data)
      if (amount !== 1n) continue
    } else if (account.programAddress !== tokenProgramId) {
      continue
    }

    positionMints.add(mint)
    if (account.programAddress === tokenProgramId) {
      bundleMints.add(mint)
    }
  }

  return { positionMints, bundleMints }
}

// function buildTokenHolderUsersFiltersByMints(
//   positionMints: Iterable<string>,
//   bundleMints: Iterable<string>,
// ): UsersFilter[] {
//   const tokenProgramId = TOKEN_PROGRAM_ID.toBase58()
//   const token2022ProgramId = TOKEN_2022_PROGRAM_ID.toBase58()
//   const filters: UsersFilter[] = []
//   const seen = new Set<string>()
//
//   function pushFilter(programId: string, mint: string): void {
//     let mintBytes: Uint8Array
//     try {
//       mintBytes = new PublicKey(mint).toBytes()
//     } catch {
//       return
//     }
//
//     const key = `${programId}:${mint}`
//     if (seen.has(key)) return
//     seen.add(key)
//
//     filters.push({
//       programId,
//       ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
//       memcmps: [{ offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mintBytes }],
//     })
//   }
//
//   for (const mint of new Set(positionMints)) {
//     pushFilter(tokenProgramId, mint)
//     pushFilter(token2022ProgramId, mint)
//   }
//
//   for (const mint of new Set(bundleMints)) {
//     pushFilter(tokenProgramId, mint)
//   }
//
//   return filters
// }

function buildRewardTokenTuple(
  whirlpool: WhirlpoolData,
  mintMap: ReadonlyMap<string, ParsedMintAccount>,
) {
  const getMint = (mint: PublicKey) => mintMap.get(mint.toBase58())
  const reward0 = whirlpool.rewardInfos[0]
  const reward1 = whirlpool.rewardInfos[1]
  const reward2 = whirlpool.rewardInfos[2]

  return [
    reward0 && PoolUtil.isRewardInitialized(reward0)
      ? (getMint(reward0.mint) ?? null)
      : null,
    reward1 && PoolUtil.isRewardInitialized(reward1)
      ? (getMint(reward1.mint) ?? null)
      : null,
    reward2 && PoolUtil.isRewardInitialized(reward2)
      ? (getMint(reward2.mint) ?? null)
      : null,
  ] as [
    ParsedMintAccount | null,
    ParsedMintAccount | null,
    ParsedMintAccount | null,
  ]
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null
}

export const orcaIntegration: SolanaIntegration = {
  platformId: 'orca',

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
    const programId = ORCA_WHIRLPOOL_PROGRAM_ID

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

    const { positionMints, bundleMints } = collectCandidateMints(
      Object.values(ownedTokenAccounts),
    )
    if (positionMints.size === 0 && bundleMints.size === 0) return []

    const candidatePositionAddresses = [...positionMints].map((mint) =>
      PDAUtil.getPosition(programId, new PublicKey(mint)).publicKey.toBase58(),
    )
    const candidateBundleAddresses = [...bundleMints].map((mint) =>
      PDAUtil.getPositionBundle(
        programId,
        new PublicKey(mint),
      ).publicKey.toBase58(),
    )

    const positionAndBundleAccounts = yield [
      ...candidatePositionAddresses,
      ...candidateBundleAddresses,
    ]

    const positionMap = new Map<string, PositionData>()
    for (const address of candidatePositionAddresses) {
      const position = parsePosition(
        address,
        positionAndBundleAccounts[address],
      )
      if (position) positionMap.set(address, position)
    }

    const bundleMap = new Map<string, PositionBundleData>()
    for (const address of candidateBundleAddresses) {
      const bundle = parsePositionBundle(
        address,
        positionAndBundleAccounts[address],
      )
      if (bundle) bundleMap.set(address, bundle)
    }

    if (bundleMap.size > 0) {
      const bundledPositionAddresses = [...bundleMap.values()].flatMap(
        (bundle) =>
          PositionBundleUtil.getOccupiedBundleIndexes(bundle).map(
            (bundleIndex) =>
              PDAUtil.getBundledPosition(
                programId,
                bundle.positionBundleMint,
                bundleIndex,
              ).publicKey.toBase58(),
          ),
      )

      if (bundledPositionAddresses.length > 0) {
        const bundledPositionAccounts = yield bundledPositionAddresses
        for (const positionAddress of bundledPositionAddresses) {
          const position = parsePosition(
            positionAddress,
            bundledPositionAccounts[positionAddress],
          )
          if (position) positionMap.set(positionAddress, position)
        }
      }
    }

    if (positionMap.size === 0) return []

    const whirlpoolAddresses = new Set<string>()
    const tickArrayAddresses = new Set<string>()

    for (const position of positionMap.values()) {
      whirlpoolAddresses.add(position.whirlpool.toBase58())
    }

    const whirlpoolAndTickAccounts = yield [
      ...whirlpoolAddresses,
      SYSVAR_CLOCK_PUBKEY.toBase58(),
    ]

    const whirlpoolMap = new Map<string, WhirlpoolData>()
    for (const whirlpoolAddress of whirlpoolAddresses) {
      const whirlpool = parseWhirlpool(
        whirlpoolAddress,
        whirlpoolAndTickAccounts[whirlpoolAddress],
      )
      if (whirlpool) whirlpoolMap.set(whirlpoolAddress, whirlpool)
    }

    if (whirlpoolMap.size === 0) return []

    for (const position of positionMap.values()) {
      const whirlpool = whirlpoolMap.get(position.whirlpool.toBase58())
      if (!whirlpool) continue

      tickArrayAddresses.add(
        PDAUtil.getTickArrayFromTickIndex(
          position.tickLowerIndex,
          whirlpool.tickSpacing,
          position.whirlpool,
          programId,
        ).publicKey.toBase58(),
      )
      tickArrayAddresses.add(
        PDAUtil.getTickArrayFromTickIndex(
          position.tickUpperIndex,
          whirlpool.tickSpacing,
          position.whirlpool,
          programId,
        ).publicKey.toBase58(),
      )
    }

    const tickAndClockAccounts = yield [
      ...tickArrayAddresses,
      SYSVAR_CLOCK_PUBKEY.toBase58(),
    ]

    const tickArrayMap = new Map<string, TickArrayData>()
    for (const tickArrayAddress of tickArrayAddresses) {
      const tickArray = parseTickArray(
        tickArrayAddress,
        tickAndClockAccounts[tickArrayAddress],
      )
      if (tickArray) tickArrayMap.set(tickArrayAddress, tickArray)
    }

    const clock =
      parseClock(tickAndClockAccounts[SYSVAR_CLOCK_PUBKEY.toBase58()]) ??
      parseClock(whirlpoolAndTickAccounts[SYSVAR_CLOCK_PUBKEY.toBase58()])
    if (!clock) return []

    const mintAddresses = new Set<string>()
    for (const whirlpool of whirlpoolMap.values()) {
      mintAddresses.add(whirlpool.tokenMintA.toBase58())
      mintAddresses.add(whirlpool.tokenMintB.toBase58())
      for (const rewardInfo of whirlpool.rewardInfos) {
        if (!PoolUtil.isRewardInitialized(rewardInfo)) continue
        mintAddresses.add(rewardInfo.mint.toBase58())
      }
    }

    const mintAccounts = yield [...mintAddresses]

    const mintMap = new Map<string, ParsedMintAccount>()
    for (const mintAddress of mintAddresses) {
      const mint = parseMint(mintAddress, mintAccounts[mintAddress])
      if (mint) mintMap.set(mintAddress, mint)
    }

    const positions: UserDefiPosition[] = []

    for (const position of positionMap.values()) {
      const whirlpool = whirlpoolMap.get(position.whirlpool.toBase58())
      if (!whirlpool) continue

      const lowerTickArrayAddress = PDAUtil.getTickArrayFromTickIndex(
        position.tickLowerIndex,
        whirlpool.tickSpacing,
        position.whirlpool,
        programId,
      ).publicKey.toBase58()
      const upperTickArrayAddress = PDAUtil.getTickArrayFromTickIndex(
        position.tickUpperIndex,
        whirlpool.tickSpacing,
        position.whirlpool,
        programId,
      ).publicKey.toBase58()

      const lowerTickArray = tickArrayMap.get(lowerTickArrayAddress)
      const upperTickArray = tickArrayMap.get(upperTickArrayAddress)
      if (!lowerTickArray || !upperTickArray) continue

      const mintA = mintMap.get(whirlpool.tokenMintA.toBase58())
      const mintB = mintMap.get(whirlpool.tokenMintB.toBase58())
      if (!mintA || !mintB) continue

      let tickLowerParsed: ReturnType<typeof TickArrayUtil.getTickFromArray>
      let tickUpperParsed: ReturnType<typeof TickArrayUtil.getTickFromArray>
      try {
        tickLowerParsed = TickArrayUtil.getTickFromArray(
          lowerTickArray,
          position.tickLowerIndex,
          whirlpool.tickSpacing,
        )
        tickUpperParsed = TickArrayUtil.getTickFromArray(
          upperTickArray,
          position.tickUpperIndex,
          whirlpool.tickSpacing,
        )
      } catch {
        continue
      }

      if (!tickLowerParsed || !tickUpperParsed) continue

      const lowerPrice = PriceMath.tickIndexToPrice(
        position.tickLowerIndex,
        mintA.decimals,
        mintB.decimals,
      )
      const upperPrice = PriceMath.tickIndexToPrice(
        position.tickUpperIndex,
        mintA.decimals,
        mintB.decimals,
      )
      const currentPrice = PriceMath.sqrtPriceX64ToPrice(
        whirlpool.sqrtPrice,
        mintA.decimals,
        mintB.decimals,
      )

      const lowerSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(
        position.tickLowerIndex,
      )
      const upperSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(
        position.tickUpperIndex,
      )
      const feeTokenExtensionCtx = {
        currentEpoch: clock.epoch,
        tokenMintWithProgramA: mintA,
        tokenMintWithProgramB: mintB,
      }
      const rewardTokenExtensionCtx = {
        currentEpoch: clock.epoch,
        rewardTokenMintsWithProgram: buildRewardTokenTuple(whirlpool, mintMap),
      }
      const principalAmounts = PoolUtil.getTokenAmountsFromLiquidity(
        position.liquidity,
        whirlpool.sqrtPrice,
        lowerSqrtPrice,
        upperSqrtPrice,
        false,
      )

      const feesQuote = collectFeesQuote({
        whirlpool,
        position,
        tickLower: tickLowerParsed,
        tickUpper: tickUpperParsed,
        tokenExtensionCtx: feeTokenExtensionCtx,
      })
      const rewardsQuote = collectRewardsQuote({
        whirlpool,
        position,
        tickLower: tickLowerParsed,
        tickUpper: tickUpperParsed,
        timeStampInSeconds: clock.unixTimestamp,
        tokenExtensionCtx: rewardTokenExtensionCtx,
      })

      const poolTokens = [
        buildPositionValue(
          whirlpool.tokenMintA.toBase58(),
          principalAmounts.tokenA,
          mintA.decimals,
          tokens.get(whirlpool.tokenMintA.toBase58())?.priceUsd,
        ),
        buildPositionValue(
          whirlpool.tokenMintB.toBase58(),
          principalAmounts.tokenB,
          mintB.decimals,
          tokens.get(whirlpool.tokenMintB.toBase58())?.priceUsd,
        ),
      ]

      const fees = [
        feesQuote.feeOwedA.gt(new BN(0))
          ? buildPositionValue(
              whirlpool.tokenMintA.toBase58(),
              feesQuote.feeOwedA,
              mintA.decimals,
              tokens.get(whirlpool.tokenMintA.toBase58())?.priceUsd,
            )
          : null,
        feesQuote.feeOwedB.gt(new BN(0))
          ? buildPositionValue(
              whirlpool.tokenMintB.toBase58(),
              feesQuote.feeOwedB,
              mintB.decimals,
              tokens.get(whirlpool.tokenMintB.toBase58())?.priceUsd,
            )
          : null,
      ].filter(isNonNull)

      const rewards = whirlpool.rewardInfos
        .map((rewardInfo, index) => {
          if (!PoolUtil.isRewardInitialized(rewardInfo)) return null

          const amount = rewardsQuote.rewardOwed[index]
          if (!amount?.gt(new BN(0))) return null

          const mint = mintMap.get(rewardInfo.mint.toBase58())
          if (!mint) return null

          return buildPositionValue(
            rewardInfo.mint.toBase58(),
            amount,
            mint.decimals,
            tokens.get(rewardInfo.mint.toBase58())?.priceUsd,
          )
        })
        .filter(isNonNull)

      const hasLiquidity = !position.liquidity.isZero()
      if (!hasLiquidity && fees.length === 0 && rewards.length === 0) continue

      const allValuedComponents = [
        ...poolTokens,
        ...fees,
        ...rewards,
      ] as PositionValue[]
      const usdValue = sumUsdValues(allValuedComponents)
      const liquidityPosition: ConcentratedRangeLiquidityDefiPosition = {
        platformId: 'orca',
        positionKind: 'liquidity',
        liquidityModel: 'concentrated-range',
        poolAddress: position.whirlpool.toBase58(),
        poolTokens,
        ...(fees.length > 0 && { fees }),
        ...(rewards.length > 0 && { rewards }),
        feeBps: divideToDecimalString(BigInt(whirlpool.feeRate), 100n, 2),
        isActive:
          whirlpool.sqrtPrice.gt(lowerSqrtPrice) &&
          whirlpool.sqrtPrice.lt(upperSqrtPrice),
        lowerPriceUsd: lowerPrice.toString(),
        upperPriceUsd: upperPrice.toString(),
        currentPriceUsd: currentPrice.toString(),
      }
      if (usdValue !== undefined) liquidityPosition.usdValue = usdValue

      positions.push(liquidityPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  // getUsersFilter: async function* (): UsersFilterPlan {
  // const orcaProgramId = ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()
  // const positionAccounts = yield {
  //   kind: 'getProgramAccounts' as const,
  //   programId: orcaProgramId,
  //   cacheTtlMs: ONE_HOUR_IN_MS,
  //   filters: [
  //     {
  //       memcmp: {
  //         offset: 0,
  //         bytes: POSITION_DISC_B64,
  //         encoding: 'base64',
  //       },
  //     },
  //   ],
  // }

  // const positionMints = new Set<string>()
  // for (const [accountAddress, account] of Object.entries(positionAccounts)) {
  //   if (!account.exists) continue
  //   if (account.programAddress !== orcaProgramId) continue

  //   const position = parsePosition(accountAddress, account)
  //   if (!position) continue
  //   positionMints.add(position.positionMint.toBase58())
  // }

  // const bundleAccounts = yield {
  //   kind: 'getProgramAccounts' as const,
  //   programId: orcaProgramId,
  //   cacheTtlMs: ONE_HOUR_IN_MS,
  //   filters: [
  //     {
  //       memcmp: {
  //         offset: 0,
  //         bytes: POSITION_BUNDLE_DISC_B64,
  //         encoding: 'base64',
  //       },
  //     },
  //   ],
  // }

  // const bundleMints = new Set<string>()
  // for (const [accountAddress, account] of Object.entries(bundleAccounts)) {
  //   if (!account.exists) continue
  //   if (account.programAddress !== orcaProgramId) continue

  //   const bundle = parsePositionBundle(accountAddress, account)
  //   if (!bundle) continue
  //   bundleMints.add(bundle.positionBundleMint.toBase58())
  // }

  // return buildTokenHolderUsersFiltersByMints(positionMints, bundleMints)
  // },
}

export default orcaIntegration
