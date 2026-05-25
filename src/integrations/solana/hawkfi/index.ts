import type {
  AccountsMap,
  ProgramRequest,
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'
import {
  PROGRAM_IDS as METEORA_PROGRAM_IDS,
  meteoraIntegration,
} from '../meteora/index'
import { PROGRAM_IDS as ORCA_PROGRAM_IDS, orcaIntegration } from '../orca/index'
import {
  PROGRAM_IDS as RAYDIUM_PROGRAM_IDS,
  raydiumIntegration,
} from '../raydium/index'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const HAWKFI_PROGRAM_ID = 'FqGg2Y1FNxMiGd51Q6UETixQWkF5fB92MysbYogRJb3P'
const HAWKFI_EXTENSION_PROGRAM_ID =
  'EZiUb6ydWpR3ciizBTJ1J36KCqLyPKVjh4yZEJbs5Uno'
const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
const HAWKFI_ACCOUNT_SIZE = 752
const HAWKFI_OWNER_OFFSET = 8
const HAWKFI_ACCOUNT_DISCRIMINATOR_BASE64 = 'kBHyBxNrrXY='
const HAWKFI_ACCOUNT_DISCRIMINATOR = Uint8Array.from(
  Buffer.from(HAWKFI_ACCOUNT_DISCRIMINATOR_BASE64, 'base64'),
)

export const PROGRAM_IDS = [
  HAWKFI_PROGRAM_ID,
  HAWKFI_EXTENSION_PROGRAM_ID,
  ...METEORA_PROGRAM_IDS,
  ...ORCA_PROGRAM_IDS,
  ...RAYDIUM_PROGRAM_IDS,
] as const

const UNDERLYING_INTEGRATIONS = [
  { platformId: 'meteora', integration: meteoraIntegration, skipPrograms: [] },
  { platformId: 'orca', integration: orcaIntegration, skipPrograms: [] },
  {
    platformId: 'raydium',
    integration: raydiumIntegration,
    skipPrograms: [RAYDIUM_AMM_V4_PROGRAM_ID],
  },
] as const

function isHawkfiAccount(account: unknown): account is SolanaAccount {
  if (typeof account !== 'object' || account === null) return false
  const maybeAccount = account as Partial<SolanaAccount>
  if (!maybeAccount.exists) return false
  if (maybeAccount.programAddress !== HAWKFI_PROGRAM_ID) return false
  if (maybeAccount.data?.length !== HAWKFI_ACCOUNT_SIZE) return false

  return Buffer.from(maybeAccount.data.subarray(0, 8)).equals(
    HAWKFI_ACCOUNT_DISCRIMINATOR,
  )
}

function toHawkfiPosition(
  position: UserDefiPosition,
  hawkfiAccount: string,
  underlyingPlatform: string,
): UserDefiPosition {
  return {
    ...position,
    platformId: 'hawkfi',
    meta: {
      ...position.meta,
      hawkfi: {
        hawkfiAccount,
        underlyingPlatform,
      },
    },
  }
}

function isProgramRequest(value: unknown): value is ProgramRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}

function filterProgramRequests(
  requests: ProgramRequest | ProgramRequest[],
  skipPrograms: readonly string[],
): ProgramRequest | ProgramRequest[] | null {
  const skipProgramSet = new Set(skipPrograms)
  const requestList = Array.isArray(requests) ? requests : [requests]
  const filtered = requestList.filter(
    (request) =>
      !('programId' in request) || !skipProgramSet.has(request.programId),
  )

  if (filtered.length === 0) return null
  const firstRequest = filtered[0]
  if (!firstRequest) return null
  return Array.isArray(requests) ? filtered : firstRequest
}

async function* getUnderlyingPositions(
  integration: SolanaIntegration,
  address: string,
  plugins: SolanaPlugins,
  skipPrograms: readonly string[],
): UserPositionsPlan {
  const getUserPositions = integration.getUserPositions
  if (!getUserPositions) return []

  const plan = getUserPositions(address, plugins)
  let step = await plan.next()

  while (!step.done) {
    const yielded = step.value
    let accounts: AccountsMap

    if (Array.isArray(yielded) && !isProgramRequest(yielded[0])) {
      accounts = yield yielded
    } else {
      const request = filterProgramRequests(
        yielded as ProgramRequest | ProgramRequest[],
        skipPrograms,
      )
      accounts = request === null ? {} : yield request
    }

    step = await plan.next(accounts)
  }

  return step.value
}

export const hawkfiIntegration: SolanaIntegration = {
  platformId: 'hawkfi',

  getUserPositions: async function* (
    address: string,
    plugins: SolanaPlugins,
  ): UserPositionsPlan {
    const hawkfiAccountsMap = yield {
      kind: 'getProgramAccounts' as const,
      programId: HAWKFI_PROGRAM_ID,
      cacheTtlMs: ONE_HOUR_IN_MS,
      filters: [
        { dataSize: HAWKFI_ACCOUNT_SIZE },
        {
          memcmp: {
            offset: 0,
            bytes: HAWKFI_ACCOUNT_DISCRIMINATOR_BASE64,
            encoding: 'base64' as const,
          },
        },
        {
          memcmp: {
            offset: HAWKFI_OWNER_OFFSET,
            bytes: address,
          },
        },
      ],
    }

    const hawkfiAccounts = Object.values(hawkfiAccountsMap)
      .filter(isHawkfiAccount)
      .map((account) => account.address)

    if (hawkfiAccounts.length === 0) return []

    const result: UserDefiPosition[] = []

    for (const hawkfiAccount of hawkfiAccounts) {
      for (const {
        integration,
        platformId,
        skipPrograms,
      } of UNDERLYING_INTEGRATIONS) {
        const positions = yield* getUnderlyingPositions(
          integration,
          hawkfiAccount,
          plugins,
          skipPrograms,
        )

        for (const position of positions) {
          result.push(toHawkfiPosition(position, hawkfiAccount, platformId))
        }
      }
    }

    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: HAWKFI_PROGRAM_ID,
      discriminator: HAWKFI_ACCOUNT_DISCRIMINATOR,
      ownerOffset: HAWKFI_OWNER_OFFSET,
      dataSize: HAWKFI_ACCOUNT_SIZE,
    },
  ],
}

export default hawkfiIntegration
