import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingDefiPosition,
  PositionValue,
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const NIRVANA_PROGRAM_ID = 'NirvHuZvrm2zSxjkBvSbaF2tHfP5j7cvMj9QmdoHVwb'
const TENANT_ADDRESS = 'BcAoCEdkzV2J21gAjCCEokBw5iMnAe96SbYo9F6QmKWV'
const DEFAULT_DECIMALS = 6
const ANA_MINT_FALLBACK = '5DkzT65YJvCsZcot9L6qwkJnsBCPmKHjJz3QU7t7QeRW'
const NIRV_MINT_FALLBACK = '3eamaYJ7yicyRd3mYz4YeNyNPGVo6zMmKUp5UP25AxRM'
const PRANA_MINT_FALLBACK = 'CLr7G2af9VSfH1PFZ5fYvB8WK1DTgE85qrVjpa8Xkg4N'

const PERSONAL_ACCOUNT_DISCRIMINATOR_B64 = createHash('sha256')
  .update('account:PersonalAccount')
  .digest()
  .subarray(0, 8)
  .toString('base64')
const PERSONAL_ACCOUNT_DISCRIMINATOR = Uint8Array.from(
  Buffer.from(PERSONAL_ACCOUNT_DISCRIMINATOR_B64, 'base64'),
)

const PUBKEY_LENGTH = 32
const PERSONAL_ACCOUNT_DATA_SIZE = 272
const PERSONAL_OWNER_OFFSET = 8
const PERSONAL_TENANT_OFFSET = PERSONAL_OWNER_OFFSET + PUBKEY_LENGTH
const PERSONAL_NIRV_BORROWED_OFFSET = 72
const PERSONAL_ANA_DEPOSITED_OFFSET = 80
const PERSONAL_STAGED_PRANA_OFFSET = 120
const PERSONAL_PRANA_REV_NIRV_STAGED_OFFSET = 264

const TENANT_DECIMALS_OFFSET = 40
const TENANT_MINT_ANA_OFFSET = 41
const TENANT_MINT_NIRV_OFFSET = TENANT_MINT_ANA_OFFSET + PUBKEY_LENGTH
const TENANT_MINT_PRANA_OFFSET = TENANT_MINT_ANA_OFFSET + PUBKEY_LENGTH * 2

type TenantSnapshot = {
  decimals: number
  mintAna: string
  mintNirv: string
  mintPrana: string
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [NIRVANA_PROGRAM_ID] as const

function readU64(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readPubkey(data: Uint8Array, offset: number): string {
  return new PublicKey(data.slice(offset, offset + PUBKEY_LENGTH)).toBase58()
}

function decodeTenant(data: Uint8Array): TenantSnapshot | null {
  if (data.length < TENANT_MINT_PRANA_OFFSET + PUBKEY_LENGTH) return null

  return {
    decimals: data[TENANT_DECIMALS_OFFSET] ?? DEFAULT_DECIMALS,
    mintAna: readPubkey(data, TENANT_MINT_ANA_OFFSET),
    mintNirv: readPubkey(data, TENANT_MINT_NIRV_OFFSET),
    mintPrana: readPubkey(data, TENANT_MINT_PRANA_OFFSET),
  }
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

export const nirvanaIntegration: SolanaIntegration = {
  platformId: 'nirvana',

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

    const personalAccountMap = yield {
      kind: 'getProgramAccounts' as const,
      programId: NIRVANA_PROGRAM_ID,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: PERSONAL_ACCOUNT_DISCRIMINATOR_B64,
            encoding: 'base64' as const,
          },
        },
        { memcmp: { offset: PERSONAL_OWNER_OFFSET, bytes: address } },
        { memcmp: { offset: PERSONAL_TENANT_OFFSET, bytes: TENANT_ADDRESS } },
        { dataSize: PERSONAL_ACCOUNT_DATA_SIZE },
      ],
    }

    const personalAccounts = Object.values(personalAccountMap).filter(
      (account): account is SolanaAccount => account.exists,
    )

    if (personalAccounts.length === 0) return []

    const tenantMap = yield [TENANT_ADDRESS]
    const tenantAccount = tenantMap[TENANT_ADDRESS]
    const tenant =
      tenantAccount?.exists === true ? decodeTenant(tenantAccount.data) : null

    const mintAna = tenant?.mintAna ?? ANA_MINT_FALLBACK
    const mintNirv = tenant?.mintNirv ?? NIRV_MINT_FALLBACK
    const mintPrana = tenant?.mintPrana ?? PRANA_MINT_FALLBACK
    const fallbackDecimals = tenant?.decimals ?? DEFAULT_DECIMALS
    const anaToken = tokens.get(mintAna)
    const nirvToken = tokens.get(mintNirv)
    const pranaToken = tokens.get(mintPrana)
    const anaDecimals = anaToken?.decimals ?? fallbackDecimals
    const nirvDecimals = nirvToken?.decimals ?? fallbackDecimals
    const pranaDecimals = pranaToken?.decimals ?? fallbackDecimals

    const result: UserDefiPosition[] = []

    for (const account of personalAccounts) {
      if (account.data.length < PERSONAL_PRANA_REV_NIRV_STAGED_OFFSET + 8) {
        continue
      }

      const nirvBorrowed = readU64(account.data, PERSONAL_NIRV_BORROWED_OFFSET)
      const anaDeposited = readU64(account.data, PERSONAL_ANA_DEPOSITED_OFFSET)
      const stagedPrana = readU64(account.data, PERSONAL_STAGED_PRANA_OFFSET)
      if (anaDeposited === 0n && stagedPrana === 0n) continue

      if (anaDeposited > 0n || nirvBorrowed > 0n || stagedPrana > 0n) {
        const supplied =
          anaDeposited > 0n
            ? [
                buildPositionValue(
                  mintAna,
                  anaDeposited,
                  anaDecimals,
                  anaToken?.priceUsd,
                ),
              ]
            : undefined

        const borrowed =
          nirvBorrowed > 0n
            ? [
                buildPositionValue(
                  mintNirv,
                  nirvBorrowed,
                  nirvDecimals,
                  nirvToken?.priceUsd,
                ),
              ]
            : undefined

        const lendingPosition: LendingDefiPosition = {
          platformId: 'nirvana',
          positionKind: 'lending',
          ...(supplied && { supplied }),
          ...(borrowed && { borrowed }),
          ...(stagedPrana > 0n && {
            rewards: [
              buildPositionValue(
                mintPrana,
                stagedPrana,
                pranaDecimals,
                pranaToken?.priceUsd,
              ),
            ],
          }),
          meta: {
            account: {
              personalAccount: account.address,
              tenant: TENANT_ADDRESS,
            },
          },
        }

        const lendingUsdValues = [
          ...(supplied ?? []),
          ...(borrowed ?? []),
          ...(lendingPosition.rewards ?? []),
        ]
          .map((value) => value.usdValue)
          .filter((value): value is string => value !== undefined)

        if (lendingUsdValues.length > 0) {
          lendingPosition.usdValue = lendingUsdValues
            .reduce((sum, value) => sum + Number(value), 0)
            .toString()
        }

        result.push(lendingPosition)
      }
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)

    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: NIRVANA_PROGRAM_ID,
      discriminator: PERSONAL_ACCOUNT_DISCRIMINATOR,
      ownerOffset: PERSONAL_OWNER_OFFSET,
      dataSize: PERSONAL_ACCOUNT_DATA_SIZE,
    },
  ],
}

export default nirvanaIntegration
