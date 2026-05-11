import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

import type {
  ConstantProductLiquidityDefiPosition,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'

const STABLE_SWAP_PROGRAM_ID = 'swapNyd8XiQwJ6ianp9snpu4brUqFxadzvHebnAXjJZ'
const WEIGHTED_SWAP_PROGRAM_ID = 'swapFpHZwjELNnjvThjajtiVmkz3yPQEHjLtka2fwHW'
const VAULT_PROGRAM_ID = 'vo1tWgqZMjG61Z2T9qUaMYKqZ75CYzMuaZ2LZP1n7HV'
const REWARDER_PROGRAM_ID = 'rev31KMq4qzt1y1iw926p694MHVVWT57caQrsHLFA4x'

const AMM_POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188] as const
const AMM_POOL_DISCRIMINATOR_B64 = Buffer.from(AMM_POOL_DISCRIMINATOR).toString(
  'base64',
)
const REWARDER_MINER_DISCRIMINATOR = [
  223, 113, 15, 54, 123, 122, 140, 100,
] as const
const REWARDER_MINER_DISCRIMINATOR_B64 = Buffer.from(
  REWARDER_MINER_DISCRIMINATOR,
).toString('base64')

const POOL_MINT_OFFSET = 72
const REWARDER_MINER_POOL_OFFSET = 8
const REWARDER_MINER_BENEFICIARY_OFFSET = 72
const REWARDER_MINER_AMOUNT_OFFSET = 105
const REWARDER_MINER_REWARDS_DEBT_OFFSET = 113
const REWARDER_MINER_REWARDS_CREDIT_OFFSET = 121
const REWARDER_POOL_REWARDER_OFFSET = 8
const REWARDER_POOL_MINT_OFFSET = 40
const REWARDER_POOL_DECIMALS_OFFSET = 72
const REWARDER_POOL_REWARDS_PER_AMOUNT_OFFSET = 125
const REWARDER_ACCOUNT_MINT_OFFSET = 40
const REWARDER_ACCOUNT_DECIMALS_OFFSET = 72
const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const MINT_SUPPLY_OFFSET = 36
const REWARDS_PER_AMOUNT_PRECISION = 1_000_000_000n

type PoolKind = 'stable' | 'weighted'

type DecodedPoolToken = {
  mint: string
  decimals: number
  scalingUp: boolean
  scalingFactor: bigint
  balance: bigint
}

type DecodedPool = {
  mint: string
  tokens: DecodedPoolToken[]
}

type PoolCandidate = {
  kind: PoolKind
  address: string
  poolMint: string
  data: Uint8Array
}

type MinerCandidate = {
  address: string
  pool: string
  amount: bigint
  rewardsDebt: bigint
  rewardsCredit: bigint
}

type DecodedRewarderPool = {
  rewarder: string
  mint: string
  decimals: number
  rewardsPerAmount: bigint
}

type DecodedRewarder = {
  mint: string
  decimals: number
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  STABLE_SWAP_PROGRAM_ID,
  WEIGHTED_SWAP_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  REWARDER_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 32) return null
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 8) return null
  return buf.readBigUInt64LE(offset)
}

function readTokenAmount(data: Uint8Array): bigint | null {
  return readU64(data, TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function readTokenMint(data: Uint8Array): string | null {
  return readPubkey(data, TOKEN_ACCOUNT_MINT_OFFSET)
}

function readMintSupply(data: Uint8Array): bigint | null {
  return readU64(data, MINT_SUPPLY_OFFSET)
}

function readU8(data: Uint8Array, offset: number): number | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 1) return null
  return buf.readUInt8(offset)
}

function readU128(data: Uint8Array, offset: number): bigint | null {
  const low = readU64(data, offset)
  const high = readU64(data, offset + 8)
  if (low === null || high === null) return null
  return low + (high << 64n)
}

function decodePoolTokens(
  data: Uint8Array,
  offsetStart: number,
  kind: PoolKind,
): DecodedPoolToken[] | null {
  const buf = Buffer.from(data)
  if (buf.length < offsetStart + 4) return null

  let offset = offsetStart
  const count = buf.readUInt32LE(offset)
  offset += 4

  const tokenSize = kind === 'stable' ? 43 : 51
  const tokens: DecodedPoolToken[] = []

  for (let index = 0; index < count; index++) {
    if (buf.length < offset + tokenSize) return null

    const mint = new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
    offset += 32

    const decimals = buf.readUInt8(offset)
    offset += 1

    const scalingUp = buf.readUInt8(offset) === 1
    offset += 1

    const scalingFactor = buf.readBigUInt64LE(offset)
    offset += 8

    const balance = buf.readBigUInt64LE(offset)
    offset += 8

    // weighted pool only: weight u64
    if (kind === 'weighted') offset += 8

    tokens.push({ mint, decimals, scalingUp, scalingFactor, balance })
  }

  return tokens
}

function decodePool(data: Uint8Array, kind: PoolKind): DecodedPool | null {
  const poolMint = readPubkey(data, POOL_MINT_OFFSET)
  if (!poolMint) return null

  // 8 discriminator + owner(32) + vault(32) + mint(32) + authority_bump(1) + is_active(1)
  let offset = 106

  // stable: amp_initial_factor(u16) + amp_target_factor(u16) + ramp_start_ts(i64)
  // + ramp_stop_ts(i64) + swap_fee(u64)
  // weighted: invariant(u64) + swap_fee(u64)
  offset += kind === 'stable' ? 28 : 16

  const tokens = decodePoolTokens(data, offset, kind)
  if (!tokens || tokens.length === 0) return null

  return {
    mint: poolMint,
    tokens,
  }
}

function decodeRewarderPool(data: Uint8Array): DecodedRewarderPool | null {
  const rewarder = readPubkey(data, REWARDER_POOL_REWARDER_OFFSET)
  const mint = readPubkey(data, REWARDER_POOL_MINT_OFFSET)
  const decimals = readU8(data, REWARDER_POOL_DECIMALS_OFFSET)
  const rewardsPerAmount = readU128(
    data,
    REWARDER_POOL_REWARDS_PER_AMOUNT_OFFSET,
  )
  if (!rewarder || !mint || decimals === null || rewardsPerAmount === null) {
    return null
  }

  return {
    rewarder,
    mint,
    decimals,
    rewardsPerAmount,
  }
}

function decodeRewarder(data: Uint8Array): DecodedRewarder | null {
  const mint = readPubkey(data, REWARDER_ACCOUNT_MINT_OFFSET)
  const decimals = readU8(data, REWARDER_ACCOUNT_DECIMALS_OFFSET)
  if (!mint || decimals === null) return null

  return {
    mint,
    decimals,
  }
}

function normalizePoolTokenAmount(token: DecodedPoolToken): bigint {
  if (token.scalingUp) {
    return token.scalingFactor === 0n ? 0n : token.balance / token.scalingFactor
  }
  return token.balance * token.scalingFactor
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

function sumUsdValues(values: PositionValue[]): string | undefined {
  const present = values
    .map((value) => value.usdValue)
    .filter((value): value is string => value !== undefined)
    .map(Number)

  if (present.length === 0) return undefined
  return present.reduce((sum, value) => sum + value, 0).toString()
}

export const stabbleIntegration: SolanaIntegration = {
  platformId: 'stabble',

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
        programId: STABLE_SWAP_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: AMM_POOL_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        cacheTtlMs: ONE_HOUR_IN_MS,
        programId: WEIGHTED_SWAP_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: AMM_POOL_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: REWARDER_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: REWARDER_MINER_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: REWARDER_MINER_BENEFICIARY_OFFSET,
              bytes: wallet.toBase58(),
            },
          },
        ],
      },
    ]

    const lpBalancesByMint = new Map<string, bigint>()
    const poolCandidates: PoolCandidate[] = []
    const miners: MinerCandidate[] = []

    for (const account of Object.values(phase0Map)) {
      if (!account.exists) continue

      if (
        account.programAddress === TOKEN_PROGRAM_ID.toBase58() ||
        account.programAddress === TOKEN_2022_PROGRAM_ID.toBase58()
      ) {
        const mint = readTokenMint(account.data)
        const amount = readTokenAmount(account.data)
        if (!mint || amount === null || amount === 0n) continue

        lpBalancesByMint.set(mint, (lpBalancesByMint.get(mint) ?? 0n) + amount)
        continue
      }

      if (
        account.programAddress !== STABLE_SWAP_PROGRAM_ID &&
        account.programAddress !== WEIGHTED_SWAP_PROGRAM_ID &&
        account.programAddress !== REWARDER_PROGRAM_ID
      ) {
        continue
      }

      if (account.programAddress === REWARDER_PROGRAM_ID) {
        const pool = readPubkey(account.data, REWARDER_MINER_POOL_OFFSET)
        const amount = readU64(account.data, REWARDER_MINER_AMOUNT_OFFSET)
        const rewardsDebt = readU64(
          account.data,
          REWARDER_MINER_REWARDS_DEBT_OFFSET,
        )
        const rewardsCredit = readU64(
          account.data,
          REWARDER_MINER_REWARDS_CREDIT_OFFSET,
        )
        if (
          !pool ||
          amount === null ||
          amount === 0n ||
          rewardsDebt === null ||
          rewardsCredit === null
        ) {
          continue
        }

        miners.push({
          address: account.address,
          pool,
          amount,
          rewardsDebt,
          rewardsCredit,
        })
        continue
      }

      const poolMint = readPubkey(account.data, POOL_MINT_OFFSET)
      if (!poolMint) continue

      poolCandidates.push({
        kind:
          account.programAddress === STABLE_SWAP_PROGRAM_ID
            ? 'stable'
            : 'weighted',
        address: account.address,
        poolMint,
        data: account.data,
      })
    }

    const positions: UserDefiPosition[] = []

    if (lpBalancesByMint.size > 0 && poolCandidates.length > 0) {
      const matchedPools = poolCandidates.filter((pool) =>
        lpBalancesByMint.has(pool.poolMint),
      )

      if (matchedPools.length > 0) {
        const round1 = yield [
          ...new Set(matchedPools.map((pool) => pool.poolMint)),
        ]

        for (const pool of matchedPools) {
          const userLpAmount = lpBalancesByMint.get(pool.poolMint)
          const mintAccount = round1[pool.poolMint]
          if (!userLpAmount || !mintAccount?.exists) continue

          const lpSupply = readMintSupply(mintAccount.data)
          if (lpSupply === null || lpSupply === 0n) continue

          const decoded = decodePool(pool.data, pool.kind)
          if (!decoded) continue

          const poolTokens: PositionValue[] = []
          for (const tokenData of decoded.tokens) {
            const normalizedPoolBalance = normalizePoolTokenAmount(tokenData)
            const userTokenAmount =
              (normalizedPoolBalance * userLpAmount) / lpSupply
            const tokenInfo = tokens.get(tokenData.mint)

            poolTokens.push(
              buildPositionValue(
                tokenData.mint,
                userTokenAmount,
                tokenData.decimals,
                tokenInfo?.priceUsd,
              ),
            )
          }

          if (poolTokens.length === 0) continue

          const usdValue = sumUsdValues(poolTokens)

          const position: ConstantProductLiquidityDefiPosition = {
            positionKind: 'liquidity',
            liquidityModel: 'constant-product',
            platformId: 'stabble',
            poolAddress: pool.address,
            lpTokenAmount: userLpAmount.toString(),
            poolTokens,
            meta: {
              pool: {
                kind: pool.kind,
              },
            },
          }
          if (usdValue !== undefined) position.usdValue = usdValue

          positions.push(position)
        }
      }
    }

    if (miners.length > 0) {
      const uniqueFarmPools = [...new Set(miners.map((miner) => miner.pool))]
      const farmPoolsMap = yield uniqueFarmPools

      const stakedByPool = new Map<string, bigint>()
      const minersByPool = new Map<string, MinerCandidate[]>()
      for (const miner of miners) {
        stakedByPool.set(
          miner.pool,
          (stakedByPool.get(miner.pool) ?? 0n) + miner.amount,
        )
        const current = minersByPool.get(miner.pool) ?? []
        current.push(miner)
        minersByPool.set(miner.pool, current)
      }

      const decodedFarmPools = new Map<string, DecodedRewarderPool>()
      const farmPoolMints = new Set<string>()
      const rewarderAddresses = new Set<string>()
      for (const [poolAddress] of stakedByPool) {
        const poolAccount = farmPoolsMap[poolAddress]
        if (!poolAccount?.exists) continue
        if (poolAccount.programAddress !== REWARDER_PROGRAM_ID) continue

        const pool = decodeRewarderPool(poolAccount.data)
        if (!pool) continue

        decodedFarmPools.set(poolAddress, pool)
        farmPoolMints.add(pool.mint)
        rewarderAddresses.add(pool.rewarder)
      }

      const farmRound1 = yield [...farmPoolMints, ...rewarderAddresses]
      const poolCandidatesByMint = new Map<string, PoolCandidate>()
      for (const candidate of poolCandidates) {
        poolCandidatesByMint.set(candidate.poolMint, candidate)
      }

      for (const [poolAddress, amount] of stakedByPool) {
        if (amount <= 0n) continue

        const pool = decodedFarmPools.get(poolAddress)
        if (!pool) continue

        const tokenInfo = tokens.get(pool.mint)
        const tokenDecimals = tokenInfo?.decimals ?? pool.decimals

        const poolCandidate = poolCandidatesByMint.get(pool.mint)
        const poolMintAccount = farmRound1[pool.mint]
        const decodedAmmPool = poolCandidate
          ? decodePool(poolCandidate.data, poolCandidate.kind)
          : null

        let staked: PositionValue[] = []
        if (decodedAmmPool && poolMintAccount?.exists) {
          const lpSupply = readMintSupply(poolMintAccount.data)
          if (lpSupply !== null && lpSupply > 0n) {
            for (const tokenData of decodedAmmPool.tokens) {
              const normalizedPoolBalance = normalizePoolTokenAmount(tokenData)
              const userTokenAmount =
                (normalizedPoolBalance * amount) / lpSupply
              const underlyingInfo = tokens.get(tokenData.mint)

              staked.push(
                buildPositionValue(
                  tokenData.mint,
                  userTokenAmount,
                  tokenData.decimals,
                  underlyingInfo?.priceUsd,
                ),
              )
            }
          }
        }

        if (staked.length === 0) {
          staked = [
            buildPositionValue(
              pool.mint,
              amount,
              tokenDecimals,
              tokenInfo?.priceUsd,
            ),
          ]
        }

        const rewarderAccount = farmRound1[pool.rewarder]
        const rewarder = rewarderAccount?.exists
          ? decodeRewarder(rewarderAccount.data)
          : null
        const minersForPool = minersByPool.get(poolAddress) ?? []
        const claimableRewardRaw = minersForPool.reduce((sum, miner) => {
          const accrued =
            (miner.amount * pool.rewardsPerAmount) /
            REWARDS_PER_AMOUNT_PRECISION
          const pending = accrued - miner.rewardsDebt + miner.rewardsCredit
          return pending > 0n ? sum + pending : sum
        }, 0n)
        const rewards =
          rewarder && claimableRewardRaw > 0n
            ? [
                buildPositionValue(
                  rewarder.mint,
                  claimableRewardRaw,
                  rewarder.decimals,
                  tokens.get(rewarder.mint)?.priceUsd,
                ),
              ]
            : undefined

        const usdValue = sumUsdValues(staked)

        const position: StakingDefiPosition = {
          positionKind: 'staking',
          platformId: 'stabble',
          staked,
          ...(rewards && { rewards }),
          meta: {
            farm: {
              poolAddress,
              rewarderAddress: pool.rewarder,
              minerAddresses: minersForPool.map((miner) => miner.address),
              stakedMint: pool.mint,
              rewardsPerAmount: pool.rewardsPerAmount.toString(),
            },
          },
        }

        if (usdValue !== undefined) {
          position.usdValue = usdValue
          position.totalStakedUsd = usdValue
        }

        positions.push(position)
      }
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: REWARDER_PROGRAM_ID,
      discriminator: Uint8Array.from(REWARDER_MINER_DISCRIMINATOR),
      ownerOffset: REWARDER_MINER_BENEFICIARY_OFFSET,
    },
  ],
}

export default stabbleIntegration
