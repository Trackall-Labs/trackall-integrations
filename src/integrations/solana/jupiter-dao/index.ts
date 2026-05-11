import { createHash } from 'node:crypto'
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
import { ONE_HOUR_IN_MS } from '../../../utils/solana'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const JUPITER_REALM = new PublicKey(
  'bJ1TRoFo2P6UHVwqdiipp6Qhp2HaaHpLowZ5LHet8Gm',
)
const GOVERN_PROGRAM_ID = new PublicKey(
  'GovaE4iu227srtG2s3tZzB4RmWBzw8sTwrCLZz7kN7rY',
)
const LOCKED_VOTER_PROGRAM_ID = new PublicKey(
  'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj',
)
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const JUP_DECIMALS = 6
const SEVEN_DAY_UNSTAKE_SECONDS = 7 * 24 * 60 * 60

const [GOVERNOR_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('Governor'), JUPITER_REALM.toBuffer()],
  GOVERN_PROGRAM_ID,
)
const [LOCKER_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from('Locker'), JUPITER_REALM.toBuffer()],
  LOCKED_VOTER_PROGRAM_ID,
)

export const PROGRAM_IDS = [
  LOCKED_VOTER_PROGRAM_ID.toBase58(),
  GOVERN_PROGRAM_ID.toBase58(),
] as const

const ESCROW_DISCRIMINATOR_B64 = accountDiscriminatorBase64('Escrow')
const ESCROW_DISCRIMINATOR = Buffer.from(ESCROW_DISCRIMINATOR_B64, 'base64')
const PARTIAL_UNSTAKING_DISCRIMINATOR_B64 =
  accountDiscriminatorBase64('PartialUnstaking')

const PUBKEY_LENGTH = 32
const ESCROW_LOCKER_OFFSET = 8
const ESCROW_OWNER_OFFSET = ESCROW_LOCKER_OFFSET + PUBKEY_LENGTH
const ESCROW_VOTE_DELEGATE_OFFSET = ESCROW_OWNER_OFFSET + PUBKEY_LENGTH
const ESCROW_AMOUNT_OFFSET = 105
const ESCROW_STARTED_AT_OFFSET = 113
const ESCROW_ENDS_AT_OFFSET = 121
const ESCROW_IS_MAX_LOCK_OFFSET = 161
const PARTIAL_UNSTAKING_ESCROW_OFFSET = 8
const PARTIAL_UNSTAKING_AMOUNT_OFFSET = 40
const PARTIAL_UNSTAKING_EXPIRATION_OFFSET = 48

type JupiterEscrow = {
  address: string
  amount: bigint
  owner: string
  voteDelegate: string
  startedAt: bigint
  endsAt: bigint
  isMaxLock: boolean
}

type PartialUnstaking = {
  escrow: string
  amount: bigint
  expiration: bigint
}

function accountDiscriminatorBase64(accountName: string): string {
  return createHash('sha256')
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8)
    .toString('base64')
}

function readPubkey(data: Uint8Array, offset: number): string {
  return new PublicKey(data.slice(offset, offset + PUBKEY_LENGTH)).toBase58()
}

function readU64(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readBool(data: Uint8Array, offset: number): boolean {
  return data[offset] === 1
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

  if (priceUsd !== undefined) {
    value.priceUsd = priceUsd.toString()
    value.usdValue = ((Number(amount) / 10 ** decimals) * priceUsd).toString()
  }

  return value
}

function decodeEscrow(address: string, data: Uint8Array): JupiterEscrow | null {
  if (data.length < ESCROW_IS_MAX_LOCK_OFFSET + 1) return null

  return {
    address,
    amount: readU64(data, ESCROW_AMOUNT_OFFSET),
    owner: readPubkey(data, ESCROW_OWNER_OFFSET),
    voteDelegate: readPubkey(data, ESCROW_VOTE_DELEGATE_OFFSET),
    startedAt: readU64(data, ESCROW_STARTED_AT_OFFSET),
    endsAt: readU64(data, ESCROW_ENDS_AT_OFFSET),
    isMaxLock: readBool(data, ESCROW_IS_MAX_LOCK_OFFSET),
  }
}

function decodePartialUnstaking(data: Uint8Array): PartialUnstaking | null {
  if (data.length < PARTIAL_UNSTAKING_EXPIRATION_OFFSET + 8) return null

  return {
    escrow: readPubkey(data, PARTIAL_UNSTAKING_ESCROW_OFFSET),
    amount: readU64(data, PARTIAL_UNSTAKING_AMOUNT_OFFSET),
    expiration: readU64(data, PARTIAL_UNSTAKING_EXPIRATION_OFFSET),
  }
}

export const jupiterDaoIntegration: SolanaIntegration = {
  platformId: 'jupiter-dao',

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

    const jupToken = tokens.get(JUP_MINT)
    const jupPriceUsd = jupToken?.priceUsd
    const jupDecimals = jupToken?.decimals ?? JUP_DECIMALS

    const escrowAccounts = yield {
      kind: 'getProgramAccounts' as const,
      programId: LOCKED_VOTER_PROGRAM_ID.toBase58(),
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: ESCROW_DISCRIMINATOR_B64,
            encoding: 'base64',
          },
        },
        {
          memcmp: {
            offset: ESCROW_OWNER_OFFSET,
            bytes: address,
          },
        },
      ],
    }

    const escrows = Object.values(escrowAccounts)
      .filter((account) => account.exists)
      .map((account) => decodeEscrow(account.address, account.data))
      .filter((escrow): escrow is JupiterEscrow => escrow !== null)

    const partialUnstakingAccounts =
      escrows.length > 0
        ? yield {
            kind: 'getProgramAccounts',
            programId: LOCKED_VOTER_PROGRAM_ID.toBase58(),
            cacheTtlMs: ONE_HOUR_IN_MS,
            filters: [
              {
                memcmp: {
                  offset: 0,
                  bytes: PARTIAL_UNSTAKING_DISCRIMINATOR_B64,
                  encoding: 'base64',
                },
              },
            ],
          }
        : {}

    const positions: UserDefiPosition[] = []
    const now = BigInt(Math.floor(Date.now() / 1000))
    const escrowAddressSet = new Set(escrows.map((escrow) => escrow.address))

    const partialsByEscrow = new Map<string, PartialUnstaking[]>()
    for (const account of Object.values(partialUnstakingAccounts)) {
      if (!account.exists) continue
      const partial = decodePartialUnstaking(account.data)
      if (
        !partial ||
        !escrowAddressSet.has(partial.escrow) ||
        partial.expiration <= now
      ) {
        continue
      }

      const current = partialsByEscrow.get(partial.escrow) ?? []
      current.push(partial)
      partialsByEscrow.set(partial.escrow, current)
    }

    for (const escrow of escrows) {
      const partials = partialsByEscrow.get(escrow.address) ?? []
      const unbondingAmount = partials.reduce(
        (sum, partial) => sum + partial.amount,
        0n,
      )
      const stakedAmount = escrow.amount - unbondingAmount
      const fullPositionValue = buildPositionValue(
        JUP_MINT,
        escrow.amount,
        jupDecimals,
        jupPriceUsd,
      )

      if (stakedAmount <= 0n && unbondingAmount <= 0n) {
        continue
      }

      const position: StakingDefiPosition = {
        platformId: 'jupiter-dao',
        positionKind: 'staking',
        ...(stakedAmount > 0n && {
          staked: [
            buildPositionValue(
              JUP_MINT,
              stakedAmount,
              jupDecimals,
              jupPriceUsd,
            ),
          ],
        }),
        ...(unbondingAmount > 0n && {
          unbonding: [
            buildPositionValue(
              JUP_MINT,
              unbondingAmount,
              jupDecimals,
              jupPriceUsd,
            ),
          ],
          lockedUntil: partials
            .reduce(
              (maxExpiration, partial) =>
                partial.expiration > maxExpiration
                  ? partial.expiration
                  : maxExpiration,
              0n,
            )
            .toString(),
          lockDuration: SEVEN_DAY_UNSTAKE_SECONDS.toString(),
        }),
        ...(fullPositionValue.usdValue !== undefined && {
          usdValue: fullPositionValue.usdValue,
          totalStakedUsd: fullPositionValue.usdValue,
        }),
        meta: {
          escrow: {
            address: escrow.address,
            owner: escrow.owner,
            voteDelegate: escrow.voteDelegate,
            governor: GOVERNOR_PDA.toBase58(),
            locker: LOCKER_PDA.toBase58(),
            isMaxLock: escrow.isMaxLock,
            partialUnstakeCount: partials.length,
          },
          ...((!escrow.isMaxLock &&
            escrow.startedAt > 0n &&
            escrow.endsAt > 0n && {
              lock: {
                startedAt: escrow.startedAt.toString(),
                endsAt: escrow.endsAt.toString(),
              },
            }) ||
            {}),
        },
      }

      if (
        unbondingAmount === 0n &&
        !escrow.isMaxLock &&
        escrow.startedAt > 0n &&
        escrow.endsAt > 0n &&
        escrow.endsAt > escrow.startedAt
      ) {
        position.lockedUntil = escrow.endsAt.toString()
        position.lockDuration = (escrow.endsAt - escrow.startedAt).toString()
      }

      positions.push(position)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: LOCKED_VOTER_PROGRAM_ID.toBase58(),
      discriminator: ESCROW_DISCRIMINATOR,
      ownerOffset: ESCROW_OWNER_OFFSET,
    },
  ],
}

export default jupiterDaoIntegration
