import { PublicKey, SYSVAR_CLOCK_PUBKEY, VoteAccount } from '@solana/web3.js'
import type {
  MaybeSolanaAccount,
  PositionValue,
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  StakedAsset,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111'
export const SOL_MINT = 'So11111111111111111111111111111111111111112'

export const PROGRAM_IDS = [STAKE_PROGRAM_ID] as const

const SOL_DECIMALS = 9
const STAKE_ACCOUNT_SIZE = 200
const STAKE_STATE_OFFSET = 0
const STAKE_STATE_STAKE = 2
const AUTHORIZED_STAKER_OFFSET = 12
const AUTHORIZED_WITHDRAWER_OFFSET = 44
const STAKE_DELEGATION_VOTER_OFFSET = 124
const STAKE_DELEGATION_STAKE_OFFSET = 156
const STAKE_ACTIVATION_EPOCH_OFFSET = 164
const STAKE_DEACTIVATION_EPOCH_OFFSET = 172
const CLOCK_EPOCH_OFFSET = 16

const U64_MAX = 18446744073709551615n
const STAKE_STATE_STAKE_DISCRIMINATOR = Uint8Array.from([2, 0, 0, 0])

export type StakeState = 'activating' | 'active' | 'deactivating' | 'inactive'

export type ParsedStakeAccount = {
  address: string
  staker: string
  withdrawer: string
  voteAccount: string
  delegatedStake: bigint
  activationEpoch: bigint
  deactivationEpoch: bigint
  state: StakeState
}

type ValidatorAggregate = {
  voteAccount: string
  validatorIdentity?: string
  commission?: number
  staked: bigint
  unbonding: bigint
  stakeAccounts: ParsedStakeAccount[]
  stateBreakdown: Record<StakeState, bigint>
}

export function readU32(data: Uint8Array, offset: number): number | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 4) return null
  return buf.readUInt32LE(offset)
}

export function readU64(data: Uint8Array, offset: number): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 8) return null
  return buf.readBigUInt64LE(offset)
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 32) return null
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

export function getStakeState(
  activationEpoch: bigint,
  deactivationEpoch: bigint,
  currentEpoch: bigint,
): StakeState {
  if (deactivationEpoch <= currentEpoch) return 'inactive'
  if (deactivationEpoch !== U64_MAX) return 'deactivating'
  if (activationEpoch > currentEpoch) return 'activating'
  return 'active'
}

export function parseStakeAccount(
  account: SolanaAccount,
  currentEpoch: bigint,
): ParsedStakeAccount | null {
  if (account.programAddress !== STAKE_PROGRAM_ID) return null
  if (account.data.length !== STAKE_ACCOUNT_SIZE) return null

  const stakeState = readU32(account.data, STAKE_STATE_OFFSET)
  const delegatedStake = readU64(account.data, STAKE_DELEGATION_STAKE_OFFSET)
  const activationEpoch = readU64(account.data, STAKE_ACTIVATION_EPOCH_OFFSET)
  const deactivationEpoch = readU64(
    account.data,
    STAKE_DEACTIVATION_EPOCH_OFFSET,
  )
  const staker = readPubkey(account.data, AUTHORIZED_STAKER_OFFSET)
  const withdrawer = readPubkey(account.data, AUTHORIZED_WITHDRAWER_OFFSET)
  const voteAccount = readPubkey(account.data, STAKE_DELEGATION_VOTER_OFFSET)

  if (
    stakeState !== STAKE_STATE_STAKE ||
    delegatedStake === null ||
    delegatedStake <= 0n ||
    activationEpoch === null ||
    deactivationEpoch === null ||
    staker === null ||
    withdrawer === null ||
    voteAccount === null
  ) {
    return null
  }

  return {
    address: account.address,
    staker,
    withdrawer,
    voteAccount,
    delegatedStake,
    activationEpoch,
    deactivationEpoch,
    state: getStakeState(activationEpoch, deactivationEpoch, currentEpoch),
  }
}

function readClockEpoch(account: MaybeSolanaAccount | undefined): bigint {
  if (!account?.exists) return 0n
  return readU64(account.data, CLOCK_EPOCH_OFFSET) ?? 0n
}

function decodeVoteAccount(account: MaybeSolanaAccount | undefined):
  | {
      validatorIdentity: string
      commission: number
    }
  | undefined {
  if (!account?.exists) return undefined

  try {
    const voteAccount = VoteAccount.fromAccountData(Buffer.from(account.data))
    return {
      validatorIdentity: voteAccount.nodePubkey.toBase58(),
      commission: voteAccount.commission,
    }
  } catch {
    return undefined
  }
}

function createAggregate(voteAccount: string): ValidatorAggregate {
  return {
    voteAccount,
    staked: 0n,
    unbonding: 0n,
    stakeAccounts: [],
    stateBreakdown: {
      activating: 0n,
      active: 0n,
      deactivating: 0n,
      inactive: 0n,
    },
  }
}

function aggregateStakeAccount(
  aggregates: Map<string, ValidatorAggregate>,
  stakeAccount: ParsedStakeAccount,
): void {
  let aggregate = aggregates.get(stakeAccount.voteAccount)
  if (aggregate === undefined) {
    aggregate = createAggregate(stakeAccount.voteAccount)
    aggregates.set(stakeAccount.voteAccount, aggregate)
  }

  aggregate.stakeAccounts.push(stakeAccount)
  aggregate.stateBreakdown[stakeAccount.state] += stakeAccount.delegatedStake

  if (stakeAccount.state === 'active' || stakeAccount.state === 'activating') {
    aggregate.staked += stakeAccount.delegatedStake
  } else {
    aggregate.unbonding += stakeAccount.delegatedStake
  }
}

function toUsdValue(
  amount: bigint,
  priceUsd: number | undefined,
): string | undefined {
  if (priceUsd === undefined) return undefined
  return ((Number(amount) / 10 ** SOL_DECIMALS) * priceUsd).toString()
}

function toPositionValue(
  amount: bigint,
  priceUsd: number | undefined,
): PositionValue {
  const usdValue = toUsdValue(amount, priceUsd)

  return {
    amount: {
      token: SOL_MINT,
      amount: amount.toString(),
      decimals: SOL_DECIMALS.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function toStakedAsset(
  amount: bigint,
  priceUsd: number | undefined,
): StakedAsset {
  return toPositionValue(amount, priceUsd)
}

function sumUsdValues(values: Array<string | undefined>): string | undefined {
  const numeric = values
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter(Number.isFinite)

  if (numeric.length === 0) return undefined
  return numeric.reduce((sum, value) => sum + value, 0).toString()
}

function buildPosition(
  aggregate: ValidatorAggregate,
  priceUsd: number | undefined,
): StakingDefiPosition {
  const staked =
    aggregate.staked > 0n ? [toStakedAsset(aggregate.staked, priceUsd)] : []
  const unbonding =
    aggregate.unbonding > 0n
      ? [toPositionValue(aggregate.unbonding, priceUsd)]
      : []

  const usdValue = sumUsdValues([staked[0]?.usdValue, unbonding[0]?.usdValue])

  return {
    platformId: 'validators',
    positionKind: 'staking',
    ...(staked.length > 0 && { staked }),
    ...(unbonding.length > 0 && { unbonding }),
    ...(usdValue !== undefined && { usdValue }),
    meta: {
      validator: {
        voteAccount: aggregate.voteAccount,
        ...(aggregate.validatorIdentity !== undefined && {
          identity: aggregate.validatorIdentity,
        }),
        ...(aggregate.commission !== undefined && {
          commission: aggregate.commission,
        }),
        stakeAccounts: aggregate.stakeAccounts.map((account) => ({
          address: account.address,
          staker: account.staker,
          withdrawer: account.withdrawer,
          amount: account.delegatedStake.toString(),
          state: account.state,
          activationEpoch: account.activationEpoch.toString(),
          deactivationEpoch: account.deactivationEpoch.toString(),
        })),
        stateBreakdown: {
          activating: aggregate.stateBreakdown.activating.toString(),
          active: aggregate.stateBreakdown.active.toString(),
          deactivating: aggregate.stateBreakdown.deactivating.toString(),
          inactive: aggregate.stateBreakdown.inactive.toString(),
        },
      },
    },
  }
}

export const validatorsIntegration: SolanaIntegration = {
  platformId: 'validators',

  getUserPositions: async function* (
    address: string,
    { tokens }: SolanaPlugins,
  ): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = tokens.get(token)
        if (tokenData?.pctPriceChange24h === undefined) return undefined
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
            offset: STAKE_STATE_OFFSET,
            bytes: Buffer.from(STAKE_STATE_STAKE_DISCRIMINATOR).toString(
              'base64',
            ),
            encoding: 'base64' as const,
          },
        },
        {
          memcmp: {
            offset: AUTHORIZED_WITHDRAWER_OFFSET,
            bytes: address,
            encoding: 'base58' as const,
          },
        },
      ],
      cacheTtlMs: ONE_MINUTE_IN_MS,
    }

    const clockAddress = SYSVAR_CLOCK_PUBKEY.toBase58()
    const clockAccount = yield [clockAddress]
    const currentEpoch = readClockEpoch(clockAccount[clockAddress])

    const aggregates = new Map<string, ValidatorAggregate>()
    for (const account of Object.values(stakeAccounts)) {
      if (!account.exists) continue
      const stakeAccount = parseStakeAccount(account, currentEpoch)
      if (stakeAccount === null) continue
      aggregateStakeAccount(aggregates, stakeAccount)
    }

    if (aggregates.size === 0) return []

    const voteAccounts = yield Array.from(aggregates.keys())
    for (const [voteAccount, aggregate] of aggregates) {
      const decoded = decodeVoteAccount(voteAccounts[voteAccount])
      if (decoded === undefined) continue
      aggregate.validatorIdentity = decoded.validatorIdentity
      aggregate.commission = decoded.commission
    }

    const priceUsd = tokens.get(SOL_MINT)?.priceUsd
    const positions: UserDefiPosition[] = Array.from(aggregates.values()).map(
      (aggregate) => buildPosition(aggregate, priceUsd),
    )

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: STAKE_PROGRAM_ID,
      discriminator: STAKE_STATE_STAKE_DISCRIMINATOR,
      ownerOffset: AUTHORIZED_WITHDRAWER_OFFSET,
      dataSize: STAKE_ACCOUNT_SIZE,
    },
  ],
}

export default validatorsIntegration
