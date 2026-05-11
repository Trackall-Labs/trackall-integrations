import { PublicKey } from '@solana/web3.js'
import type {
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

type StakeState = 'active' | 'activating' | 'deactivating' | 'inactive'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const TRAMPLIN_PROGRAM_ID = '3NJyzGWjSHP4hZvsqakodi7jAtbufwd52vn1ek6EzQ35'
const TRAMPLIN_VALIDATOR_VOTE_KEY =
  'TRAMp1Z9EXyWQQNwNjjoNvVksMUHKioVU7ky61yNsEq'
const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_DECIMALS = 9

const STAKE_ACCOUNT_SIZE = 200
const AUTHORIZED_WITHDRAWER_OFFSET = 44
const STAKE_DELEGATION_VOTER_OFFSET = 124
const STAKE_DELEGATION_STAKE_OFFSET = 156
const STAKE_ACTIVATION_EPOCH_OFFSET = 164
const STAKE_DEACTIVATION_EPOCH_OFFSET = 172

const U64_MAX = 18446744073709551615n

export const PROGRAM_IDS = [TRAMPLIN_PROGRAM_ID, STAKE_PROGRAM_ID] as const

function readU64(data: Uint8Array, offset: number): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 8) return null
  return buf.readBigUInt64LE(offset)
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 32) return null
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function getStakeState(
  activationEpoch: bigint,
  deactivationEpoch: bigint,
): StakeState {
  if (deactivationEpoch !== U64_MAX) return 'deactivating'
  if (activationEpoch === U64_MAX) return 'inactive'
  return 'active'
}

export const tramplinIntegration: SolanaIntegration = {
  platformId: 'tramplin',

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

    const stakeAccounts = yield {
      kind: 'getProgramAccounts' as const,
      programId: STAKE_PROGRAM_ID,
      filters: [
        { dataSize: STAKE_ACCOUNT_SIZE },
        {
          memcmp: {
            offset: AUTHORIZED_WITHDRAWER_OFFSET,
            bytes: address,
            encoding: 'base58',
          },
        },
        {
          memcmp: {
            offset: STAKE_DELEGATION_VOTER_OFFSET,
            bytes: TRAMPLIN_VALIDATOR_VOTE_KEY,
            encoding: 'base58',
          },
        },
      ],
    }

    const positions: UserDefiPosition[] = []
    const solToken = tokens.get(SOL_MINT)

    for (const account of Object.values(stakeAccounts)) {
      if (!account.exists) continue
      if (account.programAddress !== STAKE_PROGRAM_ID) continue

      const delegatedStake = readU64(
        account.data,
        STAKE_DELEGATION_STAKE_OFFSET,
      )
      const activationEpoch = readU64(
        account.data,
        STAKE_ACTIVATION_EPOCH_OFFSET,
      )
      const deactivationEpoch = readU64(
        account.data,
        STAKE_DEACTIVATION_EPOCH_OFFSET,
      )
      const withdrawer = readPubkey(account.data, AUTHORIZED_WITHDRAWER_OFFSET)
      const voter = readPubkey(account.data, STAKE_DELEGATION_VOTER_OFFSET)

      if (
        delegatedStake === null ||
        activationEpoch === null ||
        deactivationEpoch === null ||
        withdrawer === null ||
        voter === null ||
        delegatedStake <= 0n
      ) {
        continue
      }

      const state = getStakeState(activationEpoch, deactivationEpoch)
      const amountUi = Number(delegatedStake) / 10 ** SOL_DECIMALS
      const usdValue =
        solToken?.priceUsd === undefined
          ? undefined
          : (amountUi * solToken.priceUsd).toString()

      const value = {
        amount: {
          token: SOL_MINT,
          amount: delegatedStake.toString(),
          decimals: SOL_DECIMALS.toString(),
        },
        ...(solToken?.priceUsd !== undefined && {
          priceUsd: solToken.priceUsd.toString(),
        }),
        ...(usdValue !== undefined && { usdValue }),
      }

      const position: StakingDefiPosition = {
        platformId: 'tramplin',
        positionKind: 'staking',
        ...(state === 'deactivating'
          ? { unbonding: [value] }
          : { staked: [value] }),
        ...(usdValue !== undefined && { usdValue }),
        meta: {
          tramplin: {
            stakeAccount: account.address,
            state,
            withdrawer,
            voter,
            activationEpoch: activationEpoch.toString(),
            deactivationEpoch: deactivationEpoch.toString(),
          },
        },
      }

      positions.push(position)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },
}

export default tramplinIntegration
