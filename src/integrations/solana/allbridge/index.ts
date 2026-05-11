import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import type {
  ConstantProductLiquidityDefiPosition,
  PositionValue,
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'

const ALLBRIDGE_BRIDGE_PROGRAM_ID =
  'BrdgN2RPzEMWF96ZbnnJaUtQDQx7VRXYaHHbYCBvceWB'
const SYSTEM_PRECISION = 3
const REWARD_SHIFT_BITS = 48n

const USER_DEPOSIT_DISCRIMINATOR = accountDiscriminator('UserDeposit')
const USER_DEPOSIT_DISCRIMINATOR_B64 = Buffer.from(
  USER_DEPOSIT_DISCRIMINATOR,
).toString('base64')
const POOL_DISCRIMINATOR_B64 = accountDiscriminatorBase64('Pool')

const USER_DEPOSIT_SIZE = 88
const USER_DEPOSIT_OWNER_OFFSET = 8
const USER_DEPOSIT_MINT_OFFSET = 40
const USER_DEPOSIT_LP_AMOUNT_OFFSET = 72
const USER_DEPOSIT_REWARD_DEBT_OFFSET = 80

const POOL_SIZE = 131
const POOL_MINT_OFFSET = 8
const POOL_DECIMALS_OFFSET = 80
const POOL_ACC_REWARD_PER_SHARE_P_OFFSET = 105

type AllbridgeUserDeposit = {
  address: string
  owner: string
  mint: string
  lpAmount: bigint
  rewardDebt: bigint
}

type AllbridgePool = {
  address: string
  mint: string
  decimals: number
  accRewardPerShareP: bigint
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [ALLBRIDGE_BRIDGE_PROGRAM_ID] as const

function accountDiscriminator(accountName: string): Uint8Array {
  return createHash('sha256')
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8)
}

function accountDiscriminatorBase64(accountName: string): string {
  return Buffer.from(accountDiscriminator(accountName)).toString('base64')
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.slice(offset, offset + 32)).toBase58()
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readU128(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 16) return null
  let value = 0n
  for (let idx = 0; idx < 16; idx++) {
    value |= BigInt(data[offset + idx] ?? 0) << (8n * BigInt(idx))
  }
  return value
}

function parseUserDeposit(account: SolanaAccount): AllbridgeUserDeposit | null {
  if (account.data.length !== USER_DEPOSIT_SIZE) return null

  const owner = readPubkey(account.data, USER_DEPOSIT_OWNER_OFFSET)
  const mint = readPubkey(account.data, USER_DEPOSIT_MINT_OFFSET)
  const lpAmount = readU64(account.data, USER_DEPOSIT_LP_AMOUNT_OFFSET)
  const rewardDebt = readU64(account.data, USER_DEPOSIT_REWARD_DEBT_OFFSET)

  if (!owner || !mint || lpAmount === null || rewardDebt === null) return null

  return {
    address: account.address,
    owner,
    mint,
    lpAmount,
    rewardDebt,
  }
}

function parsePool(account: SolanaAccount): AllbridgePool | null {
  if (account.data.length !== POOL_SIZE) return null

  const mint = readPubkey(account.data, POOL_MINT_OFFSET)
  const decimals = account.data[POOL_DECIMALS_OFFSET]
  const accRewardPerShareP = readU128(
    account.data,
    POOL_ACC_REWARD_PER_SHARE_P_OFFSET,
  )

  if (!mint || decimals === undefined || accRewardPerShareP === null)
    return null

  return {
    address: account.address,
    mint,
    decimals,
    accRewardPerShareP,
  }
}

function pow10(exp: number): bigint {
  if (exp <= 0) return 1n
  return 10n ** BigInt(exp)
}

function fromSystemPrecision(amount: bigint, decimals: number): bigint {
  if (decimals >= SYSTEM_PRECISION) {
    return amount * pow10(decimals - SYSTEM_PRECISION)
  }
  return amount / pow10(SYSTEM_PRECISION - decimals)
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
  tokens: SolanaPlugins['tokens'],
): PositionValue {
  const token = tokens.get(mint)
  const usdValue = buildUsdValue(amountRaw, decimals, token?.priceUsd)

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

function calculateClaimableRewards(
  lpAmount: bigint,
  accRewardPerShareP: bigint,
  rewardDebt: bigint,
): bigint {
  const accrued = (lpAmount * accRewardPerShareP) >> REWARD_SHIFT_BITS
  if (accrued <= rewardDebt) return 0n
  return accrued - rewardDebt
}

function sumUsdValues(values: Array<string | undefined>): string | undefined {
  const numbers = values
    .filter((value): value is string => value !== undefined)
    .map(Number)

  if (numbers.length === 0) return undefined
  return numbers.reduce((sum, value) => sum + value, 0).toString()
}

export const allbridgeIntegration: SolanaIntegration = {
  platformId: 'allbridge',

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

    const combinedMap = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: ALLBRIDGE_BRIDGE_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: USER_DEPOSIT_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: USER_DEPOSIT_OWNER_OFFSET,
              bytes: address,
              encoding: 'base58',
            },
          },
          { dataSize: USER_DEPOSIT_SIZE },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: ALLBRIDGE_BRIDGE_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: POOL_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          { dataSize: POOL_SIZE },
        ],
      },
    ]

    const userDeposits = Object.values(combinedMap)
      .filter((account): account is SolanaAccount => account.exists)
      .map(parseUserDeposit)
      .filter(
        (deposit): deposit is AllbridgeUserDeposit =>
          deposit !== null &&
          deposit.owner === address &&
          deposit.lpAmount > 0n,
      )

    if (userDeposits.length === 0) return []

    const poolsByMint = new Map<string, AllbridgePool>()
    for (const account of Object.values(combinedMap)) {
      if (!account.exists) continue
      const pool = parsePool(account)
      if (!pool) continue
      poolsByMint.set(pool.mint, pool)
    }

    const positions: UserDefiPosition[] = []

    for (const userDeposit of userDeposits) {
      const pool = poolsByMint.get(userDeposit.mint)
      if (!pool) continue

      const suppliedAmountRaw = fromSystemPrecision(
        userDeposit.lpAmount,
        pool.decimals,
      )
      const poolToken = buildPositionValue(
        userDeposit.mint,
        suppliedAmountRaw,
        pool.decimals,
        tokens,
      )

      const rewardsRaw = calculateClaimableRewards(
        userDeposit.lpAmount,
        pool.accRewardPerShareP,
        userDeposit.rewardDebt,
      )
      const rewardValue =
        rewardsRaw > 0n
          ? buildPositionValue(
              userDeposit.mint,
              rewardsRaw,
              pool.decimals,
              tokens,
            )
          : undefined

      const positionUsdValue = sumUsdValues([
        poolToken.usdValue,
        rewardValue?.usdValue,
      ])

      const position: ConstantProductLiquidityDefiPosition = {
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        platformId: 'allbridge',
        poolTokens: [poolToken],
        poolAddress: pool.address,
        lpTokenAmount: userDeposit.lpAmount.toString(),
        ...(rewardValue && { rewards: [rewardValue] }),
        ...(positionUsdValue !== undefined && { usdValue: positionUsdValue }),
        meta: {
          userDeposit: {
            address: userDeposit.address,
            rewardDebt: userDeposit.rewardDebt.toString(),
          },
          pool: {
            accRewardPerShareP: pool.accRewardPerShareP.toString(),
            rewardShiftBits: REWARD_SHIFT_BITS.toString(),
            systemPrecision: SYSTEM_PRECISION,
          },
        },
      }

      applyPositionPctUsdValueChange24(tokenSource, position)
      positions.push(position)
    }

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: ALLBRIDGE_BRIDGE_PROGRAM_ID,
      discriminator: USER_DEPOSIT_DISCRIMINATOR,
      ownerOffset: USER_DEPOSIT_OWNER_OFFSET,
      dataSize: USER_DEPOSIT_SIZE,
    },
  ],
}

export default allbridgeIntegration
