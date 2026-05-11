import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import type {
  SolanaIntegration,
  SolanaPlugins,
  StakedAsset,
  StakingDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const STAKING_PROGRAM_ID = new PublicKey(
  'pytS9TjG1qyAZypk7n8rw8gfW9sUaqqYyMhJQ4E7JCQ',
)
const DEFAULT_PYTH_MINT = 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'
const DEFAULT_EPOCH_DURATION_SECONDS = 7 * 24 * 60 * 60
const PYTH_DECIMALS = 6

const CONFIG_SEED = 'config'
const POSITION_OWNER_OFFSET = 8
const POSITION_DATA_HEADER_SIZE = 40
const POSITION_BUFFER_SIZE = 200
const CONFIG_MINT_OFFSET = 41
const CONFIG_EPOCH_DURATION_OFFSET = 106
const UNLOCKING_DURATION_EPOCHS = 1n

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [STAKING_PROGRAM_ID.toBase58()] as const

const POSITION_DATA_DISCRIMINATOR_B64 =
  accountDiscriminatorBase64('PositionData')
const POSITION_DATA_DISCRIMINATOR = Uint8Array.from(
  Buffer.from(POSITION_DATA_DISCRIMINATOR_B64, 'base64'),
)

type PositionState =
  | 'LOCKING'
  | 'LOCKED'
  | 'PREUNLOCKING'
  | 'UNLOCKING'
  | 'UNLOCKED'

type ParsedPosition = {
  amount: bigint
  state: PositionState
  target: 'voting' | 'integrity-pool'
  publisher?: string
}

type Aggregate = {
  staked: bigint
  unbonding: bigint
  stakeAccounts: number
  parsedPositions: number
  states: Record<PositionState, bigint>
  targets: {
    voting: bigint
    integrityPool: bigint
  }
  publishers: Set<string>
}

function accountDiscriminatorBase64(accountName: string): string {
  return createHash('sha256')
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8)
    .toString('base64')
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function decodeConfig(accountData: Uint8Array): {
  epochDuration: bigint
  mint: string
} | null {
  const epochDuration = readU64(accountData, CONFIG_EPOCH_DURATION_OFFSET)
  if (epochDuration === null) return null

  if (accountData.length < CONFIG_MINT_OFFSET + 32) return null
  let mint: string

  try {
    mint = new PublicKey(
      accountData.slice(CONFIG_MINT_OFFSET, CONFIG_MINT_OFFSET + 32),
    ).toBase58()
  } catch {
    return null
  }

  return { epochDuration, mint }
}

function positionState(
  activationEpoch: bigint,
  unlockingStart: bigint | undefined,
  currentEpoch: bigint,
): PositionState {
  if (currentEpoch < activationEpoch) return 'LOCKING'
  if (unlockingStart === undefined) return 'LOCKED'
  if (unlockingStart > currentEpoch) return 'PREUNLOCKING'
  if (unlockingStart + UNLOCKING_DURATION_EPOCHS > currentEpoch) {
    return 'UNLOCKING'
  }
  return 'UNLOCKED'
}

function parseSlot(
  accountData: Uint8Array,
  offset: number,
  currentEpoch: bigint,
): ParsedPosition | null {
  if (accountData[offset] !== 1) return null

  let cursor = offset + 1
  const amount = readU64(accountData, cursor)
  if (amount === null) return null
  cursor += 8

  const activationEpoch = readU64(accountData, cursor)
  if (activationEpoch === null) return null
  cursor += 8

  if (accountData.length < cursor + 1) return null
  const unlockingOption = accountData[cursor]
  cursor += 1

  let unlockingStart: bigint | undefined
  if (unlockingOption === 1) {
    const value = readU64(accountData, cursor)
    if (value === null) return null
    unlockingStart = value
    cursor += 8
  } else if (unlockingOption !== 0) {
    return null
  }

  if (accountData.length < cursor + 1) return null
  const targetTag = accountData[cursor]
  cursor += 1

  let target: ParsedPosition['target']
  let publisher: string | undefined

  if (targetTag === 0) {
    target = 'voting'
  } else if (targetTag === 1) {
    if (accountData.length < cursor + 32) return null
    try {
      publisher = new PublicKey(
        accountData.slice(cursor, cursor + 32),
      ).toBase58()
    } catch {
      return null
    }
    target = 'integrity-pool'
  } else {
    return null
  }

  return {
    amount,
    state: positionState(activationEpoch, unlockingStart, currentEpoch),
    target,
    ...(publisher && { publisher }),
  }
}

function createAggregate(): Aggregate {
  return {
    staked: 0n,
    unbonding: 0n,
    stakeAccounts: 0,
    parsedPositions: 0,
    states: {
      LOCKING: 0n,
      LOCKED: 0n,
      PREUNLOCKING: 0n,
      UNLOCKING: 0n,
      UNLOCKED: 0n,
    },
    targets: {
      voting: 0n,
      integrityPool: 0n,
    },
    publishers: new Set<string>(),
  }
}

function toUsdValue(
  amount: bigint,
  decimals: number,
  priceUsd: number | undefined,
): string | undefined {
  if (priceUsd === undefined) return undefined
  return ((Number(amount) / 10 ** decimals) * priceUsd).toString()
}

function toTokenAmount(
  token: string,
  amount: bigint,
  decimals: number,
  priceUsd: number | undefined,
): StakedAsset {
  const value: StakedAsset = {
    amount: {
      token,
      amount: amount.toString(),
      decimals: decimals.toString(),
    },
  }

  if (priceUsd !== undefined) {
    value.priceUsd = priceUsd.toString()
    const usdValue = toUsdValue(amount, decimals, priceUsd)
    if (usdValue !== undefined) {
      value.usdValue = usdValue
    }
  }

  return value
}

export const pythStakingIntegration: SolanaIntegration = {
  platformId: 'pyth-staking',

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

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(CONFIG_SEED)],
      STAKING_PROGRAM_ID,
    )

    const positionAccounts = yield {
      kind: 'getProgramAccounts' as const,
      programId: STAKING_PROGRAM_ID.toBase58(),
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: POSITION_DATA_DISCRIMINATOR_B64,
            encoding: 'base64',
          },
        },
        {
          memcmp: {
            offset: POSITION_OWNER_OFFSET,
            bytes: address,
          },
        },
      ],
    }

    const configAddress = configPda.toBase58()
    const configAccounts = yield [configAddress]

    const configAccount = configAccounts[configAddress]
    const configDecoded =
      configAccount?.exists === true ? decodeConfig(configAccount.data) : null

    const epochDuration =
      configDecoded?.epochDuration && configDecoded.epochDuration > 0n
        ? configDecoded.epochDuration
        : BigInt(DEFAULT_EPOCH_DURATION_SECONDS)

    const pythMint = configDecoded?.mint ?? DEFAULT_PYTH_MINT
    const now = BigInt(Math.floor(Date.now() / 1000))
    const currentEpoch = epochDuration > 0n ? now / epochDuration : 0n

    const aggregate = createAggregate()

    for (const account of Object.values(positionAccounts)) {
      if (!account.exists) continue
      if (account.data.length < POSITION_DATA_HEADER_SIZE) continue

      aggregate.stakeAccounts += 1
      const positionCapacity = Math.floor(
        (account.data.length - POSITION_DATA_HEADER_SIZE) /
          POSITION_BUFFER_SIZE,
      )

      for (let i = 0; i < positionCapacity; i++) {
        const slot = parseSlot(
          account.data,
          POSITION_DATA_HEADER_SIZE + i * POSITION_BUFFER_SIZE,
          currentEpoch,
        )
        if (!slot) continue

        aggregate.parsedPositions += 1
        aggregate.states[slot.state] += slot.amount

        if (slot.state !== 'UNLOCKED') {
          if (slot.target === 'voting') {
            aggregate.targets.voting += slot.amount
          } else {
            aggregate.targets.integrityPool += slot.amount
            if (slot.publisher) {
              aggregate.publishers.add(slot.publisher)
            }
          }
        }

        if (
          slot.state === 'LOCKING' ||
          slot.state === 'LOCKED' ||
          slot.state === 'PREUNLOCKING'
        ) {
          aggregate.staked += slot.amount
        } else if (slot.state === 'UNLOCKING') {
          aggregate.unbonding += slot.amount
        }
      }
    }

    if (aggregate.targets.voting === 0n && aggregate.unbonding === 0n) {
      return []
    }

    const token = tokens.get(pythMint)
    const decimals = token?.decimals ?? PYTH_DECIMALS
    const priceUsd = token?.priceUsd

    const stakedEntries =
      aggregate.targets.voting > 0n
        ? [
            {
              ...toTokenAmount(
                pythMint,
                aggregate.targets.voting,
                decimals,
                priceUsd,
              ),
              cooldownPeriod: epochDuration.toString(),
            },
          ]
        : undefined

    const unbondingUsdValue = toUsdValue(
      aggregate.unbonding,
      decimals,
      priceUsd,
    )
    const unbondingEntries =
      aggregate.unbonding > 0n
        ? [
            {
              amount: {
                token: pythMint,
                amount: aggregate.unbonding.toString(),
                decimals: decimals.toString(),
              },
              ...(priceUsd !== undefined && {
                priceUsd: priceUsd.toString(),
              }),
              ...(unbondingUsdValue !== undefined && {
                usdValue: unbondingUsdValue,
              }),
            },
          ]
        : undefined

    const result: StakingDefiPosition = {
      platformId: 'pyth-staking',
      positionKind: 'staking',
      ...(stakedEntries && { staked: stakedEntries }),
      ...(unbondingEntries && { unbonding: unbondingEntries }),
      meta: {
        staking: {
          stakeAccounts: aggregate.stakeAccounts,
          parsedPositions: aggregate.parsedPositions,
          epochDurationSeconds: epochDuration.toString(),
          currentEpoch: currentEpoch.toString(),
          stateBreakdown: {
            locking: aggregate.states.LOCKING.toString(),
            locked: aggregate.states.LOCKED.toString(),
            preunlocking: aggregate.states.PREUNLOCKING.toString(),
            unlocking: aggregate.states.UNLOCKING.toString(),
            unlocked: aggregate.states.UNLOCKED.toString(),
          },
          targetBreakdown: {
            voting: aggregate.targets.voting.toString(),
            integrityPool: aggregate.targets.integrityPool.toString(),
          },
          integrityPoolPublishers: Array.from(aggregate.publishers),
        },
      },
    }

    const usdParts = [
      toUsdValue(aggregate.targets.voting, decimals, priceUsd),
      toUsdValue(aggregate.unbonding, decimals, priceUsd),
    ].filter((value): value is string => value !== undefined)

    if (usdParts.length > 0) {
      result.usdValue = usdParts
        .reduce((sum, value) => sum + Number(value), 0)
        .toString()
    }

    const positions = [result]
    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: STAKING_PROGRAM_ID.toBase58(),
      discriminator: POSITION_DATA_DISCRIMINATOR,
      ownerOffset: POSITION_OWNER_OFFSET,
    },
  ],
}

export default pythStakingIntegration
