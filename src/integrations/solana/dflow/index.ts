import { TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type {
  MaybeSolanaAccount,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  TradingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  // UsersFilter,
  // UsersFilterPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_MINUTE_IN_MS } from '../../../utils/solana'

const PREDICTION_MARKETS_PROGRAM_ID =
  'pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb'

const TOKEN_ACCOUNT_MINT_OFFSET = 0
// const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

const MARKET_LEDGER_SETTLEMENT_MINT_OFFSET = 233
const MARKET_LEDGER_YES_MINT_OFFSET = 377
const MARKET_LEDGER_NO_MINT_OFFSET = 449

type DecodedMintInfo = {
  decimals: number
  marketLedger: string
}

type DecodedMarketLedger = {
  settlementMint: string
  yesMint: string
  noMint: string
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  PREDICTION_MARKETS_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.slice(offset, offset + 32)).toBase58()
}

function readTokenAmount(data: Uint8Array): bigint | null {
  if (data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return null
  return Buffer.from(data).readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function buildPositionValue(
  token: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const value: PositionValue = {
    amount: {
      token,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
  }

  if (priceUsd !== undefined && amountRaw <= BigInt(Number.MAX_SAFE_INTEGER)) {
    value.priceUsd = priceUsd.toString()
    value.usdValue = (
      (Number(amountRaw) / 10 ** decimals) *
      priceUsd
    ).toString()
  }

  return value
}

function decodeMintInfo(
  mint: string,
  account: MaybeSolanaAccount | undefined,
): DecodedMintInfo | null {
  if (!account?.exists) return null

  try {
    const owner = new PublicKey(account.programAddress)
    const unpacked = unpackMint(
      new PublicKey(mint),
      {
        data: Buffer.from(account.data),
        owner,
        lamports: Number(account.lamports),
        executable: false,
      } satisfies AccountInfo<Buffer>,
      owner,
    )

    if (!unpacked.mintAuthority) return null

    return {
      decimals: unpacked.decimals,
      marketLedger: unpacked.mintAuthority.toBase58(),
    }
  } catch {
    return null
  }
}

function decodeMarketLedger(
  account: MaybeSolanaAccount | undefined,
): DecodedMarketLedger | null {
  if (!account?.exists) return null
  if (account.programAddress !== PREDICTION_MARKETS_PROGRAM_ID) return null

  const settlementMint = readPubkey(
    account.data,
    MARKET_LEDGER_SETTLEMENT_MINT_OFFSET,
  )
  const yesMint = readPubkey(account.data, MARKET_LEDGER_YES_MINT_OFFSET)
  const noMint = readPubkey(account.data, MARKET_LEDGER_NO_MINT_OFFSET)

  if (!settlementMint || !yesMint || !noMint) return null

  return { settlementMint, yesMint, noMint }
}

function sumUsdValues(values: Array<string | undefined>): string | undefined {
  const present = values
    .filter((value): value is string => value !== undefined)
    .map(Number)

  if (present.length === 0) return undefined
  return present.reduce((sum, value) => sum + value, 0).toString()
}

// function buildToken2022HolderUsersFiltersByMints(
//   mints: Iterable<string>,
// ): UsersFilter[] {
//   const filters: UsersFilter[] = []
//   const token2022ProgramId = TOKEN_2022_PROGRAM_ID.toBase58()

//   for (const mint of new Set(mints)) {
//     let mintBytes: Uint8Array
//     try {
//       mintBytes = new PublicKey(mint).toBytes()
//     } catch {
//       continue
//     }

//     filters.push({
//       programId: token2022ProgramId,
//       ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
//       memcmps: [{ offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mintBytes }],
//     })
//   }

//   return filters
// }

export const dflowIntegration: SolanaIntegration = {
  platformId: 'dflow',

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

    const phase0Map = yield {
      kind: 'getTokenAccountsByOwner' as const,
      owner: address,
      programId: TOKEN_2022_PROGRAM_ID.toBase58(),
      cacheTtlMs: ONE_MINUTE_IN_MS,
    }

    const balancesByMint = new Map<string, bigint>()
    for (const account of Object.values(phase0Map)) {
      if (!account.exists) continue
      if (account.programAddress !== TOKEN_2022_PROGRAM_ID.toBase58()) continue

      const mint = readPubkey(account.data, TOKEN_ACCOUNT_MINT_OFFSET)
      const amountRaw = readTokenAmount(account.data)
      if (!mint || amountRaw === null || amountRaw <= 0n) continue

      balancesByMint.set(mint, (balancesByMint.get(mint) ?? 0n) + amountRaw)
    }

    if (balancesByMint.size === 0) return []

    const mintAddresses = [...balancesByMint.keys()]
    const mintAccountsMap = yield mintAddresses

    const mintInfoByMint = new Map<string, DecodedMintInfo>()
    const marketLedgerSet = new Set<string>()
    for (const mint of mintAddresses) {
      const decoded = decodeMintInfo(mint, mintAccountsMap[mint])
      if (!decoded) continue

      mintInfoByMint.set(mint, decoded)
      marketLedgerSet.add(decoded.marketLedger)
    }

    if (marketLedgerSet.size === 0) return []

    const marketLedgerAddresses = [...marketLedgerSet]
    const marketLedgerAccountsMap = yield marketLedgerAddresses

    const marketByLedger = new Map<string, DecodedMarketLedger>()
    for (const marketLedger of marketLedgerAddresses) {
      const decoded = decodeMarketLedger(marketLedgerAccountsMap[marketLedger])
      if (!decoded) continue
      marketByLedger.set(marketLedger, decoded)
    }

    if (marketByLedger.size === 0) return []

    const grouped = new Map<
      string,
      {
        marketLedger: string
        settlementMint: string
        yesMint: string
        noMint: string
        deposited: PositionValue[]
        outcomes: Array<{
          mint: string
          side: 'yes' | 'no'
          amount: string
          decimals: string
        }>
      }
    >()

    for (const [mint, amountRaw] of balancesByMint) {
      const mintInfo = mintInfoByMint.get(mint)
      if (!mintInfo) continue

      const market = marketByLedger.get(mintInfo.marketLedger)
      if (!market) continue

      const side =
        market.yesMint === mint ? 'yes' : market.noMint === mint ? 'no' : null
      if (!side) continue

      const tokenInfo = tokens.get(mint)
      const deposited = buildPositionValue(
        mint,
        amountRaw,
        mintInfo.decimals,
        tokenInfo?.priceUsd,
      )

      const key = mintInfo.marketLedger
      const existing = grouped.get(key)
      if (existing) {
        existing.deposited.push(deposited)
        existing.outcomes.push({
          mint,
          side,
          amount: amountRaw.toString(),
          decimals: mintInfo.decimals.toString(),
        })
      } else {
        grouped.set(key, {
          marketLedger: mintInfo.marketLedger,
          settlementMint: market.settlementMint,
          yesMint: market.yesMint,
          noMint: market.noMint,
          deposited: [deposited],
          outcomes: [
            {
              mint,
              side,
              amount: amountRaw.toString(),
              decimals: mintInfo.decimals.toString(),
            },
          ],
        })
      }
    }

    const positions: UserDefiPosition[] = []
    for (const group of grouped.values()) {
      group.deposited.sort((left, right) =>
        left.amount.token.localeCompare(right.amount.token),
      )
      group.outcomes.sort((left, right) => left.mint.localeCompare(right.mint))

      const usdValue = sumUsdValues(
        group.deposited.map((item) => item.usdValue),
      )

      positions.push({
        platformId: 'dflow',
        positionKind: 'trading',
        marketType: 'spot',
        marginEnabled: false,
        deposited: group.deposited,
        ...(usdValue !== undefined && { usdValue }),
        meta: {
          dflow: {
            marketLedger: group.marketLedger,
            settlementMint: group.settlementMint,
            yesMint: group.yesMint,
            noMint: group.noMint,
            outcomes: group.outcomes,
          },
        },
      } satisfies TradingDefiPosition)
    }

    positions.sort((left, right) => {
      const leftLedger = left.meta?.dflow?.marketLedger
      const rightLedger = right.meta?.dflow?.marketLedger
      if (typeof leftLedger !== 'string' || typeof rightLedger !== 'string') {
        return 0
      }
      return leftLedger.localeCompare(rightLedger)
    })

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  // getUsersFilter: async function* (): UsersFilterPlan {
  //   const predictionAccounts = yield {
  //     kind: 'getProgramAccounts' as const,
  //     programId: PREDICTION_MARKETS_PROGRAM_ID,
  //     filters: [],
  //   }

  //   const outcomeMints = new Set<string>()
  //   for (const account of Object.values(predictionAccounts)) {
  //     const market = decodeMarketLedger(account)
  //     if (!market) continue
  //     outcomeMints.add(market.yesMint)
  //     outcomeMints.add(market.noMint)
  //   }

  //   return buildToken2022HolderUsersFiltersByMints(outcomeMints)
  // },
}

export default dflowIntegration
