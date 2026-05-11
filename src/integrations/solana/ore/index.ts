import { PublicKey } from '@solana/web3.js'
import type {
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const ORE_PROGRAM_ID = new PublicKey(
  'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv',
)
const ORE_MINT = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp'
const ORE_DECIMALS = 11
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_DECIMALS = 9

const MINER_DISCRIMINATOR = 103
const TREASURY_DISCRIMINATOR = 104
const STAKE_DISCRIMINATOR = 108
const MINER_DISCRIMINATOR_BYTES = Uint8Array.from([MINER_DISCRIMINATOR])
const STAKE_DISCRIMINATOR_BYTES = Uint8Array.from([STAKE_DISCRIMINATOR])
const AUTHORITY_OFFSET = 8

// Miner account offsets (Steel framework, 8-byte account header)
const MINER_DEPLOYED_OFFSET = 40 // [u64; 25]
const MINER_REWARDS_FACTOR_OFFSET = 472 // Numeric (I80F48, 16 bytes)
const MINER_REWARDS_SOL_OFFSET = 488
const MINER_REWARDS_ORE_OFFSET = 496
const MINER_REFINED_ORE_OFFSET = 504

// Stake account offsets
const STAKE_BALANCE_OFFSET = 40
const STAKE_REWARDS_FACTOR_OFFSET = 112 // Numeric (I80F48, 16 bytes)
const STAKE_REWARDS_OFFSET = 128

// Treasury account offsets
const TREASURY_MINER_REWARDS_FACTOR_OFFSET = 32 // Numeric (I80F48, 16 bytes)
const TREASURY_STAKE_REWARDS_FACTOR_OFFSET = 48 // Numeric (I80F48, 16 bytes)

const I80F48_FRACTION_BITS = 48n

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [ORE_PROGRAM_ID.toBase58()] as const

function readU64(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readI128LE(data: Uint8Array, offset: number): bigint {
  const buf = Buffer.from(data)
  const lo = buf.readBigUInt64LE(offset)
  const hi = buf.readBigUInt64LE(offset + 8)
  const combined = lo + (hi << 64n)
  return BigInt.asIntN(128, combined)
}

function usdFromRawAmount(
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  return ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
}

export function accruedFromRewardFactorDelta(
  accountFactor: bigint,
  treasuryFactor: bigint,
  weightRaw: bigint,
): bigint {
  if (treasuryFactor <= accountFactor || weightRaw <= 0n) return 0n
  const delta = treasuryFactor - accountFactor
  const scaled = delta * weightRaw
  if (scaled <= 0n) return 0n
  return scaled / (1n << I80F48_FRACTION_BITS)
}

function totalDeployed(data: Uint8Array): bigint {
  let sum = 0n
  for (let i = 0; i < 25; i++) {
    sum += readU64(data, MINER_DEPLOYED_OFFSET + i * 8)
  }
  return sum
}

export const oreIntegration: SolanaIntegration = {
  platformId: 'ore',

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

    const authority = new PublicKey(address)

    const [minerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('miner'), authority.toBuffer()],
      ORE_PROGRAM_ID,
    )
    const [stakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('stake'), authority.toBuffer()],
      ORE_PROGRAM_ID,
    )
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury')],
      ORE_PROGRAM_ID,
    )
    const minerKey = minerPda.toBase58()
    const stakeKey = stakePda.toBase58()
    const treasuryKey = treasuryPda.toBase58()

    // Round 0: fetch user + global treasury PDAs in one batch
    const accountsMap = yield [minerKey, stakeKey, treasuryKey]
    const treasuryAcc = accountsMap[treasuryKey]

    const treasuryMinerRewardsFactor =
      treasuryAcc?.exists && treasuryAcc.data[0] === TREASURY_DISCRIMINATOR
        ? readI128LE(treasuryAcc.data, TREASURY_MINER_REWARDS_FACTOR_OFFSET)
        : undefined
    const treasuryStakeRewardsFactor =
      treasuryAcc?.exists && treasuryAcc.data[0] === TREASURY_DISCRIMINATOR
        ? readI128LE(treasuryAcc.data, TREASURY_STAKE_REWARDS_FACTOR_OFFSET)
        : undefined

    const result: UserDefiPosition[] = []

    // --- Miner position ---
    const minerAcc = accountsMap[minerKey]
    if (minerAcc?.exists && minerAcc.data[0] === MINER_DISCRIMINATOR) {
      const deployedLamports = totalDeployed(minerAcc.data)
      const minerRewardsFactor = readI128LE(
        minerAcc.data,
        MINER_REWARDS_FACTOR_OFFSET,
      )
      const unrefinedOre = readU64(minerAcc.data, MINER_REWARDS_ORE_OFFSET)
      const baseRefinedOre = readU64(minerAcc.data, MINER_REFINED_ORE_OFFSET)
      const rewardsSol = readU64(minerAcc.data, MINER_REWARDS_SOL_OFFSET)

      const accruedRefinedOre =
        treasuryMinerRewardsFactor !== undefined
          ? accruedFromRewardFactorDelta(
              minerRewardsFactor,
              treasuryMinerRewardsFactor,
              unrefinedOre,
            )
          : 0n
      const refinedOre = baseRefinedOre + accruedRefinedOre
      const refiningFeeOre = unrefinedOre > 0n ? -(unrefinedOre / 10n) : 0n

      if (unrefinedOre > 0n || refinedOre > 0n || rewardsSol > 0n) {
        const solToken = tokens.get(SOL_MINT)
        const oreToken = tokens.get(ORE_MINT)

        const unrefinedOreUsd = usdFromRawAmount(
          unrefinedOre,
          ORE_DECIMALS,
          oreToken?.priceUsd,
        )
        const refinedOreUsd = usdFromRawAmount(
          refinedOre,
          ORE_DECIMALS,
          oreToken?.priceUsd,
        )
        const refiningFeeOreUsd = usdFromRawAmount(
          refiningFeeOre,
          ORE_DECIMALS,
          oreToken?.priceUsd,
        )
        const solRewardsUsd = usdFromRawAmount(
          rewardsSol,
          SOL_DECIMALS,
          solToken?.priceUsd,
        )

        const position: StakingDefiPosition = {
          platformId: 'ore',
          positionKind: 'staking',
          rewards: [
            ...(unrefinedOre > 0n
              ? [
                  {
                    amount: {
                      token: ORE_MINT,
                      amount: unrefinedOre.toString(),
                      decimals: ORE_DECIMALS.toString(),
                    },
                    ...(oreToken?.priceUsd !== undefined && {
                      priceUsd: oreToken.priceUsd.toString(),
                    }),
                    ...(unrefinedOreUsd !== undefined && {
                      usdValue: unrefinedOreUsd,
                    }),
                  },
                ]
              : []),
            ...(refinedOre > 0n
              ? [
                  {
                    amount: {
                      token: ORE_MINT,
                      amount: refinedOre.toString(),
                      decimals: ORE_DECIMALS.toString(),
                    },
                    ...(oreToken?.priceUsd !== undefined && {
                      priceUsd: oreToken.priceUsd.toString(),
                    }),
                    ...(refinedOreUsd !== undefined && {
                      usdValue: refinedOreUsd,
                    }),
                  },
                ]
              : []),
            ...(refiningFeeOre < 0n
              ? [
                  {
                    amount: {
                      token: ORE_MINT,
                      amount: refiningFeeOre.toString(),
                      decimals: ORE_DECIMALS.toString(),
                    },
                    ...(oreToken?.priceUsd !== undefined && {
                      priceUsd: oreToken.priceUsd.toString(),
                    }),
                    ...(refiningFeeOreUsd !== undefined && {
                      usdValue: refiningFeeOreUsd,
                    }),
                  },
                ]
              : []),
            ...(rewardsSol > 0n
              ? [
                  {
                    amount: {
                      token: SOL_MINT,
                      amount: rewardsSol.toString(),
                      decimals: SOL_DECIMALS.toString(),
                    },
                    ...(solToken?.priceUsd !== undefined && {
                      priceUsd: solToken.priceUsd.toString(),
                    }),
                    ...(solRewardsUsd !== undefined && {
                      usdValue: solRewardsUsd,
                    }),
                  },
                ]
              : []),
          ],
          meta: {
            ore: {
              deployedLamportsRaw: deployedLamports.toString(),
              unrefinedOreRaw: unrefinedOre.toString(),
              refinedOreStoredRaw: baseRefinedOre.toString(),
              refinedOreAccruedRaw: accruedRefinedOre.toString(),
              refiningFeeRaw: refiningFeeOre.toString(),
            },
          },
        }

        const usdParts = [
          unrefinedOreUsd,
          refinedOreUsd,
          refiningFeeOreUsd,
          solRewardsUsd,
        ].filter((v): v is string => v !== undefined)
        if (usdParts.length > 0) {
          position.usdValue = usdParts
            .reduce((sum, v) => sum + Number(v), 0)
            .toString()
        }

        result.push(position)
      }
    }

    // --- Stake position ---
    const stakeAcc = accountsMap[stakeKey]
    if (stakeAcc?.exists && stakeAcc.data[0] === STAKE_DISCRIMINATOR) {
      const balance = readU64(stakeAcc.data, STAKE_BALANCE_OFFSET)
      const baseRewards = readU64(stakeAcc.data, STAKE_REWARDS_OFFSET)
      const stakeRewardsFactor = readI128LE(
        stakeAcc.data,
        STAKE_REWARDS_FACTOR_OFFSET,
      )
      const accruedRewards =
        treasuryStakeRewardsFactor !== undefined
          ? accruedFromRewardFactorDelta(
              stakeRewardsFactor,
              treasuryStakeRewardsFactor,
              balance,
            )
          : 0n
      const rewards = baseRewards + accruedRewards

      if (balance > 0n || rewards > 0n) {
        const oreToken = tokens.get(ORE_MINT)

        const stakedUsd =
          usdFromRawAmount(balance, ORE_DECIMALS, oreToken?.priceUsd) ?? '0'
        const rewardsUsd = usdFromRawAmount(
          rewards,
          ORE_DECIMALS,
          oreToken?.priceUsd,
        )

        const position: StakingDefiPosition = {
          platformId: 'ore',
          positionKind: 'staking',
          ...(balance > 0n && {
            staked: [
              {
                amount: {
                  token: ORE_MINT,
                  amount: balance.toString(),
                  decimals: ORE_DECIMALS.toString(),
                },
                ...(oreToken?.priceUsd !== undefined && {
                  priceUsd: oreToken.priceUsd.toString(),
                }),
                usdValue: stakedUsd,
              },
            ],
          }),
          ...(rewards > 0n && {
            rewards: [
              {
                amount: {
                  token: ORE_MINT,
                  amount: rewards.toString(),
                  decimals: ORE_DECIMALS.toString(),
                },
                ...(oreToken?.priceUsd !== undefined && {
                  priceUsd: oreToken.priceUsd.toString(),
                }),
                ...(rewardsUsd !== undefined && { usdValue: rewardsUsd }),
              },
            ],
          }),
          meta: {
            ore: {
              stakeRewardsStoredRaw: baseRewards.toString(),
              stakeRewardsAccruedRaw: accruedRewards.toString(),
            },
          },
        }

        const usdParts = [stakedUsd, rewardsUsd].filter(
          (v): v is string => v !== undefined,
        )
        if (usdParts.length > 0) {
          position.usdValue = usdParts
            .reduce((sum, v) => sum + Number(v), 0)
            .toString()
        }

        result.push(position)
      }
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)

    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: ORE_PROGRAM_ID.toBase58(),
      discriminator: MINER_DISCRIMINATOR_BYTES,
      ownerOffset: AUTHORITY_OFFSET,
    },
    {
      programId: ORE_PROGRAM_ID.toBase58(),
      discriminator: STAKE_DISCRIMINATOR_BYTES,
      ownerOffset: AUTHORITY_OFFSET,
    },
  ],
}

export default oreIntegration
