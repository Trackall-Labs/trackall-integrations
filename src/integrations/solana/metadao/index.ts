import { createHash } from 'node:crypto'
import { unpackMint } from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type {
  MaybeSolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const LAUNCHPAD_V7_PROGRAM_ID = 'moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM'
const TOKENS_TO_PARTICIPANTS = 10_000_000n * 1_000_000n

const FUNDING_RECORD_FUNDER_OFFSET = 9
const FUNDING_RECORD_LAUNCH_OFFSET = 41
const FUNDING_RECORD_COMMITTED_AMOUNT_OFFSET = 73
const FUNDING_RECORD_IS_TOKENS_CLAIMED_OFFSET = 81
const FUNDING_RECORD_IS_USDC_REFUNDED_OFFSET = 82
const FUNDING_RECORD_APPROVED_AMOUNT_OFFSET = 83
const FUNDING_RECORD_LENGTH = 115

const LAUNCH_STATE_LABELS = [
  'initialized',
  'live',
  'closed',
  'complete',
  'refunding',
] as const
const LIVE_LAUNCH_STATE = 1

type FundingRecord = {
  address: string
  launch: string
  committedAmount: bigint
  approvedAmount: bigint
  isTokensClaimed: boolean
  isUsdcRefunded: boolean
}

type LaunchRecord = {
  address: string
  state: number
  stateLabel: string
  baseMint: string
  quoteMint: string
  totalApprovedAmount: bigint
  unixTimestampStarted: bigint | null
  unixTimestampClosed: bigint | null
  unixTimestampCompleted: bigint | null
}

export const testAddress = 'DGSW2tbP5r5KfYyWfiEyNU3rwNX2Atc7maktu8WjGyp6'

export const PROGRAM_IDS = [LAUNCHPAD_V7_PROGRAM_ID] as const

const FUNDING_RECORD_DISCRIMINATOR = accountDiscriminator('FundingRecord')
const FUNDING_RECORD_DISCRIMINATOR_B64 = Buffer.from(
  FUNDING_RECORD_DISCRIMINATOR,
).toString('base64')

function accountDiscriminator(accountName: string): Uint8Array {
  return createHash('sha256')
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8)
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.slice(offset, offset + 32)).toBase58()
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function decodeFundingRecord(
  address: string,
  data: Uint8Array,
): FundingRecord | null {
  if (data.length < FUNDING_RECORD_LENGTH) return null

  const launch = readPubkey(data, FUNDING_RECORD_LAUNCH_OFFSET)
  const committedAmount = readU64(data, FUNDING_RECORD_COMMITTED_AMOUNT_OFFSET)
  const approvedAmount = readU64(data, FUNDING_RECORD_APPROVED_AMOUNT_OFFSET)

  if (!launch || committedAmount === null || approvedAmount === null) {
    return null
  }

  return {
    address,
    launch,
    committedAmount,
    approvedAmount,
    isTokensClaimed: data[FUNDING_RECORD_IS_TOKENS_CLAIMED_OFFSET] === 1,
    isUsdcRefunded: data[FUNDING_RECORD_IS_USDC_REFUNDED_OFFSET] === 1,
  }
}

type Cursor = { offset: number }

function readU8WithCursor(data: Uint8Array, cursor: Cursor): number | null {
  if (data.length < cursor.offset + 1) return null
  return data[cursor.offset++] ?? null
}

function readU32WithCursor(data: Uint8Array, cursor: Cursor): number | null {
  if (data.length < cursor.offset + 4) return null
  const value = Buffer.from(data).readUInt32LE(cursor.offset)
  cursor.offset += 4
  return value
}

function readU64WithCursor(data: Uint8Array, cursor: Cursor): bigint | null {
  if (data.length < cursor.offset + 8) return null
  const value = Buffer.from(data).readBigUInt64LE(cursor.offset)
  cursor.offset += 8
  return value
}

function readI64WithCursor(data: Uint8Array, cursor: Cursor): bigint | null {
  if (data.length < cursor.offset + 8) return null
  const value = Buffer.from(data).readBigInt64LE(cursor.offset)
  cursor.offset += 8
  return value
}

function readPubkeyWithCursor(data: Uint8Array, cursor: Cursor): string | null {
  if (data.length < cursor.offset + 32) return null
  const value = new PublicKey(
    data.slice(cursor.offset, cursor.offset + 32),
  ).toBase58()
  cursor.offset += 32
  return value
}

function readOptionI64WithCursor(
  data: Uint8Array,
  cursor: Cursor,
): bigint | null | undefined {
  const tag = readU8WithCursor(data, cursor)
  if (tag === null) return undefined
  if (tag === 0) return null
  if (tag !== 1) return undefined
  return readI64WithCursor(data, cursor)
}

function skipOptionPubkeyWithCursor(data: Uint8Array, cursor: Cursor): boolean {
  const tag = readU8WithCursor(data, cursor)
  if (tag === null) return false
  if (tag === 0) return true
  if (tag !== 1) return false
  return readPubkeyWithCursor(data, cursor) !== null
}

function skipPubkeyVecWithCursor(data: Uint8Array, cursor: Cursor): boolean {
  const len = readU32WithCursor(data, cursor)
  if (len === null) return false

  const bytes = len * 32
  if (data.length < cursor.offset + bytes) return false

  cursor.offset += bytes
  return true
}

function decodeLaunch(address: string, data: Uint8Array): LaunchRecord | null {
  const cursor: Cursor = { offset: 8 }

  if (readU8WithCursor(data, cursor) === null) return null
  if (readU64WithCursor(data, cursor) === null) return null
  if (readU64WithCursor(data, cursor) === null) return null
  if (!skipPubkeyVecWithCursor(data, cursor)) return null
  if (readPubkeyWithCursor(data, cursor) === null) return null
  if (readPubkeyWithCursor(data, cursor) === null) return null
  if (readU8WithCursor(data, cursor) === null) return null
  if (readPubkeyWithCursor(data, cursor) === null) return null
  if (readPubkeyWithCursor(data, cursor) === null) return null

  const baseMint = readPubkeyWithCursor(data, cursor)
  const quoteMint = readPubkeyWithCursor(data, cursor)
  const unixTimestampStarted = readOptionI64WithCursor(data, cursor)
  const unixTimestampClosed = readOptionI64WithCursor(data, cursor)

  if (
    !baseMint ||
    !quoteMint ||
    unixTimestampStarted === undefined ||
    unixTimestampClosed === undefined
  ) {
    return null
  }

  if (readU64WithCursor(data, cursor) === null) return null

  const state = readU8WithCursor(data, cursor)
  if (state === null) return null

  if (readU64WithCursor(data, cursor) === null) return null
  if (readU32WithCursor(data, cursor) === null) return null
  if (!skipOptionPubkeyWithCursor(data, cursor)) return null
  if (!skipOptionPubkeyWithCursor(data, cursor)) return null
  if (readPubkeyWithCursor(data, cursor) === null) return null
  if (readU64WithCursor(data, cursor) === null) return null
  if (readU8WithCursor(data, cursor) === null) return null
  if (readPubkeyWithCursor(data, cursor) === null) return null

  const totalApprovedAmount = readU64WithCursor(data, cursor)
  if (totalApprovedAmount === null) return null

  if (readU64WithCursor(data, cursor) === null) return null
  if (!skipOptionPubkeyWithCursor(data, cursor)) return null
  if (readU8WithCursor(data, cursor) === null) return null

  const unixTimestampCompleted = readOptionI64WithCursor(data, cursor)
  if (unixTimestampCompleted === undefined) return null

  return {
    address,
    state,
    stateLabel: LAUNCH_STATE_LABELS[state] ?? `unknown(${state})`,
    baseMint,
    quoteMint,
    totalApprovedAmount,
    unixTimestampStarted,
    unixTimestampClosed,
    unixTimestampCompleted,
  }
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

function decodeMintDecimals(
  address: string,
  account: MaybeSolanaAccount | undefined,
): number | null {
  const accountInfo = toAccountInfo(account)
  if (!accountInfo) return null

  try {
    return unpackMint(new PublicKey(address), accountInfo, accountInfo.owner)
      .decimals
  } catch {
    return null
  }
}

export const metadaoIntegration: SolanaIntegration = {
  platformId: 'metadao',

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

    const owner = new PublicKey(address).toBase58()

    const fundingRecordsMap = yield {
      kind: 'getProgramAccounts' as const,
      programId: LAUNCHPAD_V7_PROGRAM_ID,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: FUNDING_RECORD_DISCRIMINATOR_B64,
            encoding: 'base64',
          },
        },
        {
          memcmp: {
            offset: FUNDING_RECORD_FUNDER_OFFSET,
            bytes: owner,
          },
        },
      ],
    }

    const fundingRecords = Object.values(fundingRecordsMap)
      .filter(
        (account): account is Exclude<typeof account, { exists: false }> => {
          return account.exists
        },
      )
      .map((account) => decodeFundingRecord(account.address, account.data))
      .filter((record): record is FundingRecord => record !== null)

    if (fundingRecords.length === 0) return []

    const launchAddresses = [
      ...new Set(fundingRecords.map((record) => record.launch)),
    ]

    const launchAccountsMap = yield launchAddresses

    const launches = new Map<string, LaunchRecord>()
    for (const launchAddress of launchAddresses) {
      const account = launchAccountsMap[launchAddress]
      if (!account?.exists) continue

      const launch = decodeLaunch(launchAddress, account.data)
      if (launch) launches.set(launchAddress, launch)
    }

    if (launches.size === 0) return []

    const liveFundingRecords = fundingRecords.filter((record) => {
      return launches.get(record.launch)?.state === LIVE_LAUNCH_STATE
    })

    if (liveFundingRecords.length === 0) return []

    const mintAddresses = [
      ...new Set(
        liveFundingRecords.flatMap((record) => {
          const launch = launches.get(record.launch)
          return launch ? [launch.baseMint, launch.quoteMint] : []
        }),
      ),
    ]

    const mintAccountsMap = yield mintAddresses

    const mintDecimals = new Map<string, number>()
    for (const mintAddress of mintAddresses) {
      const decimals = decodeMintDecimals(
        mintAddress,
        mintAccountsMap[mintAddress],
      )
      if (decimals !== null) mintDecimals.set(mintAddress, decimals)
    }

    const positions: UserDefiPosition[] = []

    for (const fundingRecord of liveFundingRecords) {
      const launch = launches.get(fundingRecord.launch)
      if (!launch) continue

      const quoteToken = tokens.get(launch.quoteMint)
      const baseToken = tokens.get(launch.baseMint)
      const quoteDecimals =
        mintDecimals.get(launch.quoteMint) ?? quoteToken?.decimals ?? 0
      const baseDecimals =
        mintDecimals.get(launch.baseMint) ?? baseToken?.decimals ?? 0

      const stakedQuoteUsd =
        quoteToken?.priceUsd !== undefined
          ? (Number(fundingRecord.committedAmount) / 10 ** quoteDecimals) *
            quoteToken.priceUsd
          : undefined

      let claimableBaseAmount = 0n
      if (
        launch.state === 3 &&
        !fundingRecord.isTokensClaimed &&
        fundingRecord.approvedAmount > 0n &&
        launch.totalApprovedAmount > 0n
      ) {
        claimableBaseAmount =
          (fundingRecord.approvedAmount * TOKENS_TO_PARTICIPANTS) /
          launch.totalApprovedAmount
      }

      let claimableRefundAmount = 0n
      if (!fundingRecord.isUsdcRefunded) {
        if (launch.state === 4) {
          claimableRefundAmount = fundingRecord.committedAmount
        } else if (
          launch.state === 3 &&
          fundingRecord.committedAmount > fundingRecord.approvedAmount
        ) {
          claimableRefundAmount =
            fundingRecord.committedAmount - fundingRecord.approvedAmount
        }
      }

      const rewards: NonNullable<StakingDefiPosition['rewards']> = []

      if (claimableBaseAmount > 0n) {
        const usdValue =
          baseToken?.priceUsd !== undefined
            ? (Number(claimableBaseAmount) / 10 ** baseDecimals) *
              baseToken.priceUsd
            : undefined

        rewards.push({
          amount: {
            token: launch.baseMint,
            amount: claimableBaseAmount.toString(),
            decimals: baseDecimals.toString(),
          },
          ...(baseToken?.priceUsd !== undefined && {
            priceUsd: baseToken.priceUsd.toString(),
          }),
          ...(usdValue !== undefined && { usdValue: usdValue.toString() }),
        })
      }

      if (claimableRefundAmount > 0n) {
        const usdValue =
          quoteToken?.priceUsd !== undefined
            ? (Number(claimableRefundAmount) / 10 ** quoteDecimals) *
              quoteToken.priceUsd
            : undefined

        rewards.push({
          amount: {
            token: launch.quoteMint,
            amount: claimableRefundAmount.toString(),
            decimals: quoteDecimals.toString(),
          },
          ...(quoteToken?.priceUsd !== undefined && {
            priceUsd: quoteToken.priceUsd.toString(),
          }),
          ...(usdValue !== undefined && { usdValue: usdValue.toString() }),
        })
      }

      const position: StakingDefiPosition = {
        platformId: 'metadao',
        positionKind: 'staking',
        ...(fundingRecord.committedAmount > 0n && {
          staked: [
            {
              amount: {
                token: launch.quoteMint,
                amount: fundingRecord.committedAmount.toString(),
                decimals: quoteDecimals.toString(),
              },
              ...(quoteToken?.priceUsd !== undefined && {
                priceUsd: quoteToken.priceUsd.toString(),
              }),
              ...(stakedQuoteUsd !== undefined && {
                usdValue: stakedQuoteUsd.toString(),
              }),
            },
          ],
        }),
        ...(rewards.length > 0 && { rewards }),
        meta: {
          launchpad: {
            launch: launch.address,
            fundingRecord: fundingRecord.address,
            programId: LAUNCHPAD_V7_PROGRAM_ID,
            state: launch.stateLabel,
            committedAmount: fundingRecord.committedAmount.toString(),
            approvedAmount: fundingRecord.approvedAmount.toString(),
            totalApprovedAmount: launch.totalApprovedAmount.toString(),
            isTokensClaimed: fundingRecord.isTokensClaimed,
            isUsdcRefunded: fundingRecord.isUsdcRefunded,
            ...(launch.unixTimestampStarted !== null && {
              unixTimestampStarted: launch.unixTimestampStarted.toString(),
            }),
            ...(launch.unixTimestampClosed !== null && {
              unixTimestampClosed: launch.unixTimestampClosed.toString(),
            }),
            ...(launch.unixTimestampCompleted !== null && {
              unixTimestampCompleted: launch.unixTimestampCompleted.toString(),
            }),
          },
        },
      }

      const usdParts = [
        stakedQuoteUsd,
        ...rewards
          .map((entry) => entry.usdValue)
          .filter((value): value is string => value !== undefined)
          .map(Number),
      ]
        .filter((value): value is number => value !== undefined)
        .filter((value) => Number.isFinite(value))

      if (usdParts.length > 0) {
        position.usdValue = usdParts
          .reduce((sum, value) => sum + value, 0)
          .toString()
      }

      if (
        (position.staked?.length ?? 0) > 0 ||
        (position.rewards?.length ?? 0) > 0
      ) {
        positions.push(position)
      }
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: LAUNCHPAD_V7_PROGRAM_ID,
      discriminator: FUNDING_RECORD_DISCRIMINATOR,
      ownerOffset: FUNDING_RECORD_FUNDER_OFFSET,
    },
  ],
}

export default metadaoIntegration
