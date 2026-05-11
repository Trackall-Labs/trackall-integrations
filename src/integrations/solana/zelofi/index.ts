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

const ZELOFI_PROGRAM_ID = '3weDTR2PBop8SoYXpQEhdRCA9Wr2JK7gj3CxuUbMo2VJ'
const USER_RECORD_SEED = 'user-v2'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_DECIMALS = 9

const USER_RECORD_ACCOUNT_SIZE = 56
const USER_RECORD_USER_KEY_OFFSET = 8
const USER_RECORD_SOL_DEPOSIT_OFFSET = 40
const USER_RECORD_AVERAGE_AGE_OFFSET = 48

const ZELOFI_PROGRAM_PUBKEY = new PublicKey(ZELOFI_PROGRAM_ID)

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [ZELOFI_PROGRAM_ID] as const

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58()
}

function toUsdValue(
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
}

export const zelofiIntegration: SolanaIntegration = {
  platformId: 'zelofi',

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

    const user = new PublicKey(address)
    const [userRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(USER_RECORD_SEED), user.toBuffer()],
      ZELOFI_PROGRAM_PUBKEY,
    )

    const accounts = yield [userRecordPda.toBase58()]
    const account = accounts[userRecordPda.toBase58()]

    if (!account?.exists) return []
    if (account.programAddress !== ZELOFI_PROGRAM_ID) return []
    if (account.data.length < USER_RECORD_ACCOUNT_SIZE) return []

    const accountUserKey = readPubkey(account.data, USER_RECORD_USER_KEY_OFFSET)
    const solDeposit = readU64(account.data, USER_RECORD_SOL_DEPOSIT_OFFSET)
    const averageAge = readU64(account.data, USER_RECORD_AVERAGE_AGE_OFFSET)

    if (!accountUserKey || !solDeposit || !averageAge) return []
    if (accountUserKey !== address || solDeposit <= 0n) return []

    const solToken = tokens.get(SOL_MINT)
    const usdValue = toUsdValue(solDeposit, SOL_DECIMALS, solToken?.priceUsd)
    const positionValue = {
      amount: {
        token: SOL_MINT,
        amount: solDeposit.toString(),
        decimals: SOL_DECIMALS.toString(),
      },
      ...(solToken?.priceUsd !== undefined && {
        priceUsd: solToken.priceUsd.toString(),
      }),
      ...(usdValue !== undefined && { usdValue }),
    }

    const position: StakingDefiPosition = {
      platformId: 'zelofi',
      positionKind: 'staking',
      staked: [positionValue],
      ...(usdValue !== undefined && { usdValue }),
      meta: {
        zelofi: {
          userRecord: userRecordPda.toBase58(),
          userKey: accountUserKey,
          averageAge: averageAge.toString(),
        },
      },
    }

    const positions = [position] satisfies UserDefiPosition[]
    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: ZELOFI_PROGRAM_ID,
      ownerOffset: USER_RECORD_USER_KEY_OFFSET,
      dataSize: USER_RECORD_ACCOUNT_SIZE,
    },
  ],
}

export default zelofiIntegration
