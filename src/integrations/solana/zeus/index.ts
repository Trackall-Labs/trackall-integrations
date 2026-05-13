import { PublicKey } from '@solana/web3.js'
import type {
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const ZEUS_PROGRAM_ID = 'SYNMjud3ALEaeJhxuq8gpc2wJzC4XLHfxp9SgKmzQ8r'
const BTCSOL_MINT = 'BSoLov7Es6mGLkBq7Z89PSWDmk6Vsw4jVxdfE2UHrJTX'
const BTCSOL_DECIMALS = 9
const ZBTC_MINT = 'zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg'
const ZBTC_DECIMALS = 8

const USER_POSITION_DISCRIMINATOR = new Uint8Array([
  251, 248, 209, 245, 83, 234, 17, 27,
])
const REDEEM_REQUEST_DISCRIMINATOR = new Uint8Array([
  103, 82, 139, 51, 199, 234, 111, 115,
])
const USER_POSITION_DISCRIMINATOR_B64 = Buffer.from(
  USER_POSITION_DISCRIMINATOR,
).toString('base64')
const REDEEM_REQUEST_DISCRIMINATOR_B64 = Buffer.from(
  REDEEM_REQUEST_DISCRIMINATOR,
).toString('base64')
const OWNER_OFFSET_IN_USER_POSITION = 40
const STRATEGY_GROUP_OFFSET = 72
const SYNTHETIC_AMOUNT_OFFSET = 168
const USER_OFFSET_IN_REDEEM_REQUEST = 8
const UNDERLYING_MINT_OFFSET_IN_REDEEM_REQUEST = 104
const SYNTHETIC_AMOUNT_REQUESTED_OFFSET = 136
const UNDERLYING_AMOUNT_TO_REDEEM_OFFSET = 144
const REFUNDABLE_AFTER_TS_OFFSET = 184

const KNOWN_STRATEGY_GROUPS: Record<string, string> = {
  CMBwsHiUnih1VAzENzoNKTq8tyRaCpD2zBgBUm47sN6h: 'mSOL',
  '9HGpvmW1Lv2pqKkbM41pGm7ApMjgdXt7Refdv5hoFejJ': 'jupSOL',
  '67zGEwrzVJvn9owJR8aL693K1eMoH28WiDKDE17xNmf8': 'kySOL',
}

type StrategyState = {
  staked: bigint
  syntheticStaked: bigint
  unbonding: PositionValue[]
  assetMint?: string
  assetDecimals?: number
  latestUnlockAt?: bigint
  treasuryReceipt?: TreasuryDistributionReceipt
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [ZEUS_PROGRAM_ID] as const

function hasDiscriminator(
  data: Uint8Array,
  discriminator: Uint8Array,
): boolean {
  if (data.length < discriminator.length) return false
  for (let i = 0; i < discriminator.length; i++) {
    if (data[i] !== discriminator[i]) return false
  }
  return true
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58()
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readI64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigInt64LE(offset)
}

function readU128(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 16) return null
  const buffer = Buffer.from(data)
  const low = buffer.readBigUInt64LE(offset)
  const high = buffer.readBigUInt64LE(offset + 8)
  return low + (high << 64n)
}

function buildPositionValue(
  token: string,
  amount: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const value: PositionValue = {
    amount: {
      token,
      amount: amount.toString(),
      decimals: decimals.toString(),
    },
  }

  if (
    priceUsd !== undefined &&
    amount <= BigInt(Number.MAX_SAFE_INTEGER) &&
    Number.isFinite(priceUsd)
  ) {
    value.priceUsd = priceUsd.toString()
    value.usdValue = ((Number(amount) / 10 ** decimals) * priceUsd).toString()
  }

  return value
}

function mergeUsdValues(values: Array<string | undefined>): string | undefined {
  const entries = values
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter(Number.isFinite)

  if (entries.length === 0) return undefined
  return entries.reduce((sum, value) => sum + value, 0).toString()
}

const EMPTY_PUBKEY = '11111111111111111111111111111111'
const STRATEGY_UNDERLYING_START_OFFSET = 360
const STRATEGY_UNDERLYING_ENTRY_SIZE = 400
const STRATEGY_UNDERLYING_MINT_REL_OFFSET = 0
const STRATEGY_UNDERLYING_EPOCH_RATIO_REL_OFFSET = 256
const STRATEGY_UNDERLYING_DECIMALS_REL_OFFSET = 376
const EXCHANGE_RATIO_SCALE = 10n ** 12n

const USER_POSITION_TREASURY_RECEIPTS_OFFSET = 193
const DISTRIBUTION_RECEIPT_SIZE = 104
const DISTRIBUTION_RECEIPT_TOKEN_MINT_REL_OFFSET = 32
const DISTRIBUTION_RECEIPT_OWED_AMOUNT_SCALED_REL_OFFSET = 64
const DISTRIBUTION_RECEIPT_LAST_ACCUMULATED_REL_OFFSET = 80

const STRATEGY_TREASURY_TOKEN_START_OFFSET =
  STRATEGY_UNDERLYING_START_OFFSET + 3 * STRATEGY_UNDERLYING_ENTRY_SIZE
const STRATEGY_TREASURY_TOKEN_ENTRY_SIZE = 400
const STRATEGY_TREASURY_TOKEN_MINT_REL_OFFSET = 0
const STRATEGY_TREASURY_TOKEN_MIN_CLAIM_REL_OFFSET = 192
const STRATEGY_TREASURY_TOKEN_ACCUMULATED_REL_OFFSET = 320

const DISTRIBUTION_SHARES_SCALE = 10n ** 9n
const DISTRIBUTION_OWED_SCALE = 10n ** 6n

type StrategyConversion = {
  mint: string
  decimals: number
  epochStartRatio: bigint
}

type TreasuryDistributionReceipt = {
  owedAmountScaled: bigint
  lastAccumulatedAmountScaledPerShare: bigint
}

type TreasuryDistribution = {
  minAmountToClaim: bigint
  accumulatedAmountScaledPerShare: bigint
}

function decodeStrategyConversion(data: Uint8Array): StrategyConversion | null {
  for (let index = 0; index < 3; index++) {
    const base =
      STRATEGY_UNDERLYING_START_OFFSET + index * STRATEGY_UNDERLYING_ENTRY_SIZE
    const mint = readPubkey(data, base + STRATEGY_UNDERLYING_MINT_REL_OFFSET)
    const epochStartRatio = readU128(
      data,
      base + STRATEGY_UNDERLYING_EPOCH_RATIO_REL_OFFSET,
    )

    if (!mint || !epochStartRatio) continue
    if (mint === EMPTY_PUBKEY || epochStartRatio <= 0n) continue

    const decimalsOffset = base + STRATEGY_UNDERLYING_DECIMALS_REL_OFFSET
    if (data.length < decimalsOffset + 1) continue
    const decimals = data[decimalsOffset] ?? 0

    return { mint, decimals, epochStartRatio }
  }

  return null
}

function convertSyntheticToUnderlying(
  syntheticAmount: bigint,
  conversion: StrategyConversion,
): bigint {
  return (syntheticAmount * EXCHANGE_RATIO_SCALE) / conversion.epochStartRatio
}

function decodeTreasuryDistributionReceipt(
  data: Uint8Array,
): TreasuryDistributionReceipt | null {
  for (let index = 0; index < 5; index++) {
    const base =
      USER_POSITION_TREASURY_RECEIPTS_OFFSET + index * DISTRIBUTION_RECEIPT_SIZE
    const tokenMint = readPubkey(
      data,
      base + DISTRIBUTION_RECEIPT_TOKEN_MINT_REL_OFFSET,
    )
    if (tokenMint !== ZBTC_MINT) continue

    const owedAmountScaled = readU128(
      data,
      base + DISTRIBUTION_RECEIPT_OWED_AMOUNT_SCALED_REL_OFFSET,
    )
    const lastAccumulatedAmountScaledPerShare = readU128(
      data,
      base + DISTRIBUTION_RECEIPT_LAST_ACCUMULATED_REL_OFFSET,
    )
    if (
      owedAmountScaled === null ||
      lastAccumulatedAmountScaledPerShare === null
    )
      return null

    return { owedAmountScaled, lastAccumulatedAmountScaledPerShare }
  }

  return null
}

function decodeTreasuryDistribution(
  data: Uint8Array,
): TreasuryDistribution | null {
  for (let index = 0; index < 5; index++) {
    const base =
      STRATEGY_TREASURY_TOKEN_START_OFFSET +
      index * STRATEGY_TREASURY_TOKEN_ENTRY_SIZE
    const tokenMint = readPubkey(
      data,
      base + STRATEGY_TREASURY_TOKEN_MINT_REL_OFFSET,
    )
    if (tokenMint !== ZBTC_MINT) continue

    const minAmountToClaim = readU64(
      data,
      base + STRATEGY_TREASURY_TOKEN_MIN_CLAIM_REL_OFFSET,
    )
    const accumulatedAmountScaledPerShare = readU128(
      data,
      base + STRATEGY_TREASURY_TOKEN_ACCUMULATED_REL_OFFSET,
    )
    if (minAmountToClaim === null || accumulatedAmountScaledPerShare === null)
      return null

    return { minAmountToClaim, accumulatedAmountScaledPerShare }
  }

  return null
}

function calculateTreasuryRewardAmount(
  syntheticAmount: bigint,
  receipt: TreasuryDistributionReceipt | undefined,
  distribution: TreasuryDistribution | null,
): bigint {
  if (!receipt || !distribution) return 0n

  const accumulatedDelta =
    distribution.accumulatedAmountScaledPerShare >
    receipt.lastAccumulatedAmountScaledPerShare
      ? distribution.accumulatedAmountScaledPerShare -
        receipt.lastAccumulatedAmountScaledPerShare
      : 0n
  const accruedAmountScaled =
    (syntheticAmount * accumulatedDelta) / DISTRIBUTION_SHARES_SCALE
  const claimableAmount =
    (receipt.owedAmountScaled + accruedAmountScaled) / DISTRIBUTION_OWED_SCALE

  return claimableAmount >= distribution.minAmountToClaim ? claimableAmount : 0n
}

export const zeusIntegration: SolanaIntegration = {
  platformId: 'zeus',

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

    const nowUnix = BigInt(Math.floor(Date.now() / 1000))
    const strategyState = new Map<string, StrategyState>()

    const accounts = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: ZEUS_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: USER_POSITION_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: OWNER_OFFSET_IN_USER_POSITION,
              bytes: address,
              encoding: 'base58',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: ZEUS_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: REDEEM_REQUEST_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: USER_OFFSET_IN_REDEEM_REQUEST,
              bytes: address,
              encoding: 'base58',
            },
          },
        ],
      },
    ]

    for (const account of Object.values(accounts)) {
      if (!account.exists || account.programAddress !== ZEUS_PROGRAM_ID)
        continue
      if (!hasDiscriminator(account.data, USER_POSITION_DISCRIMINATOR)) continue

      const owner = readPubkey(account.data, OWNER_OFFSET_IN_USER_POSITION)
      const strategyGroup = readPubkey(account.data, STRATEGY_GROUP_OFFSET)
      const syntheticAmount = readU64(account.data, SYNTHETIC_AMOUNT_OFFSET)
      const treasuryReceipt = decodeTreasuryDistributionReceipt(account.data)
      if (
        !owner ||
        !strategyGroup ||
        syntheticAmount === null ||
        owner !== address
      )
        continue

      const current = strategyState.get(strategyGroup)
      if (current) {
        if (syntheticAmount > 0n) {
          current.staked += syntheticAmount
          current.syntheticStaked += syntheticAmount
        }
        if (treasuryReceipt) current.treasuryReceipt = treasuryReceipt
      } else {
        strategyState.set(strategyGroup, {
          staked: syntheticAmount > 0n ? syntheticAmount : 0n,
          syntheticStaked: syntheticAmount > 0n ? syntheticAmount : 0n,
          unbonding: [],
          ...(treasuryReceipt && { treasuryReceipt }),
        })
      }
    }

    for (const account of Object.values(accounts)) {
      if (!account.exists || account.programAddress !== ZEUS_PROGRAM_ID)
        continue
      if (!hasDiscriminator(account.data, REDEEM_REQUEST_DISCRIMINATOR))
        continue

      const user = readPubkey(account.data, USER_OFFSET_IN_REDEEM_REQUEST)
      const strategyGroup = readPubkey(account.data, STRATEGY_GROUP_OFFSET)
      const requested = readU64(account.data, SYNTHETIC_AMOUNT_REQUESTED_OFFSET)
      const underlyingMint = readPubkey(
        account.data,
        UNDERLYING_MINT_OFFSET_IN_REDEEM_REQUEST,
      )
      const underlyingAmountToRedeem = readU64(
        account.data,
        UNDERLYING_AMOUNT_TO_REDEEM_OFFSET,
      )
      const refundableAfter = readI64(account.data, REFUNDABLE_AFTER_TS_OFFSET)
      if (!user || !strategyGroup || requested === null || user !== address)
        continue
      if (requested <= 0n) continue

      const state = strategyState.get(strategyGroup) ?? {
        staked: 0n,
        syntheticStaked: 0n,
        unbonding: [],
      }
      const unbondingMint = underlyingMint ?? state.assetMint ?? BTCSOL_MINT
      const unbondingDecimals = state.assetDecimals ?? BTCSOL_DECIMALS
      const unbondingAmount =
        underlyingAmountToRedeem && underlyingAmountToRedeem > 0n
          ? underlyingAmountToRedeem
          : requested
      const unbondingToken = tokens.get(unbondingMint)
      state.unbonding.push(
        buildPositionValue(
          unbondingMint,
          unbondingAmount,
          unbondingDecimals,
          unbondingToken?.priceUsd,
        ),
      )
      state.assetMint = unbondingMint
      state.assetDecimals = unbondingDecimals

      if (
        refundableAfter !== null &&
        refundableAfter > nowUnix &&
        (state.latestUnlockAt === undefined ||
          refundableAfter > state.latestUnlockAt)
      ) {
        state.latestUnlockAt = refundableAfter
      }

      strategyState.set(strategyGroup, state)
    }

    const activeStrategyGroups = [...strategyState.entries()]
      .filter(([, state]) => state.staked > 0n || state.unbonding.length > 0)
      .map(([strategyGroup]) => strategyGroup)

    const strategyAccounts =
      activeStrategyGroups.length > 0 ? yield activeStrategyGroups : {}
    const treasuryRewardsByStrategy = new Map<string, bigint>()

    for (const strategyGroup of activeStrategyGroups) {
      const strategyAccount = strategyAccounts[strategyGroup]
      if (!strategyAccount?.exists) continue

      const state = strategyState.get(strategyGroup)
      if (!state) continue

      const conversion = decodeStrategyConversion(strategyAccount.data)
      if (conversion) {
        state.assetMint = conversion.mint
        state.assetDecimals = conversion.decimals
        state.staked = convertSyntheticToUnderlying(
          state.syntheticStaked,
          conversion,
        )
      }

      const rewardAmount = calculateTreasuryRewardAmount(
        state.syntheticStaked,
        state.treasuryReceipt,
        decodeTreasuryDistribution(strategyAccount.data),
      )
      if (rewardAmount > 0n) {
        treasuryRewardsByStrategy.set(strategyGroup, rewardAmount)
      }
    }

    const positions: UserDefiPosition[] = []

    for (const [strategyGroup, state] of strategyState.entries()) {
      if (state.staked <= 0n && state.unbonding.length === 0) continue

      const assetMint = state.assetMint ?? BTCSOL_MINT
      const assetDecimals = state.assetDecimals ?? BTCSOL_DECIMALS
      const assetToken = tokens.get(assetMint)
      const stakedValue =
        state.staked > 0n
          ? buildPositionValue(
              assetMint,
              state.staked,
              assetDecimals,
              assetToken?.priceUsd,
            )
          : undefined
      const rewardAmount = treasuryRewardsByStrategy.get(strategyGroup) ?? 0n
      const rewardToken = tokens.get(ZBTC_MINT)
      const rewards =
        rewardAmount > 0n
          ? [
              buildPositionValue(
                ZBTC_MINT,
                rewardAmount,
                ZBTC_DECIMALS,
                rewardToken?.priceUsd,
              ),
            ]
          : undefined

      const strategyName = KNOWN_STRATEGY_GROUPS[strategyGroup] ?? 'unknown'

      const position: StakingDefiPosition = {
        platformId: 'zeus',
        positionKind: 'staking',
        ...(stakedValue && { staked: [stakedValue] }),
        ...(state.unbonding.length > 0 && { unbonding: state.unbonding }),
        ...(rewards && { rewards }),
        ...(state.latestUnlockAt !== undefined && {
          lockedUntil: state.latestUnlockAt.toString(),
        }),
        meta: {
          strategyGroup: {
            address: strategyGroup,
            name: strategyName,
          },
        },
      }

      const usdValue = mergeUsdValues([
        stakedValue?.usdValue,
        ...state.unbonding.map((entry) => entry.usdValue),
        ...(rewards ?? []).map((reward) => reward.usdValue),
      ])
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
      programId: ZEUS_PROGRAM_ID,
      discriminator: USER_POSITION_DISCRIMINATOR,
      ownerOffset: OWNER_OFFSET_IN_USER_POSITION,
    },
    {
      programId: ZEUS_PROGRAM_ID,
      discriminator: REDEEM_REQUEST_DISCRIMINATOR,
      ownerOffset: USER_OFFSET_IN_REDEEM_REQUEST,
    },
  ],
}

export default zeusIntegration
