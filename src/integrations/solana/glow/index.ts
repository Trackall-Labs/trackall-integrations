import { unpackAccount, unpackMint } from '@solana/spl-token'
import { type AccountInfo, PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const MARGIN_PROGRAM_ID = 'GLoWMgcn3VbyFKiC2FGMgfKxYSyTJS7uKFwKY2CSkq9X'
const MARGIN_POOL_PROGRAM_ID = 'CWPeEXnSpELj7tSz9W4oQAGGRbavBtdnhY2bWMyPoo1'
const AIRSPACE_PROGRAM_ID = 'AmAJeyNxxjNHfhBoCpsNMgWxhukdv3DSu3XpLfJspace'

export const PROGRAM_IDS = [
  MARGIN_PROGRAM_ID,
  MARGIN_POOL_PROGRAM_ID,
  AIRSPACE_PROGRAM_ID,
] as const

const MARGIN_ACCOUNT_DISC_B64 = 'hdyt1bPTK+4='
const TOKEN_CONFIG_DISC_B64 = 'XEn/K2szdWU='
const MARGIN_POOL_DISC_B64 = 'jv8cIMSoqq8='
const MARGIN_ACCOUNT_DISCRIMINATOR = Buffer.from(
  MARGIN_ACCOUNT_DISC_B64,
  'base64',
)

const OWNER_OFFSET = 16
const AIRSPACE_OFFSET = 48
const LIQUIDATOR_OFFSET = 80
const PUBKEY_SIZE = 32
const TOKEN_CONFIG_MINT_OFFSET = 8
const TOKEN_CONFIG_AIRSPACE_OFFSET = 136
const TOKEN_CONFIG_KIND_OFFSET = 168

const MARGIN_POOL_DEPOSIT_NOTE_MINT_OFFSET = 106
const MARGIN_POOL_LOAN_NOTE_MINT_OFFSET = 138
const MARGIN_POOL_TOKEN_MINT_OFFSET = 170
const MARGIN_POOL_BORROWED_TOKENS_OFFSET = 280
const MARGIN_POOL_UNCOLLECTED_FEES_OFFSET = 304
const MARGIN_POOL_DEPOSIT_TOKENS_OFFSET = 328
const MARGIN_POOL_DEPOSIT_NOTES_OFFSET = 336
const MARGIN_POOL_LOAN_NOTES_OFFSET = 344
const U64_SIZE = 8
const GLOW_NUMBER_SIZE = 24
const GLOW_NUMBER_SCALE = 1_000_000_000_000_000n

type TokenKind = 'Collateral' | 'Claim' | 'AdapterCollateral'

interface MarginAccountLite {
  address: string
  owner: string
  airspace: string
  liquidator: string
}

interface TokenConfigLite {
  mint: string
  airspace: string
  kind: TokenKind
}

interface DerivedTokenAccount {
  marginAccount: string
  mint: string
  kind: TokenKind
  tokenAccount: string
}

interface DecodedTokenBalance {
  marginAccount: string
  mint: string
  kind: TokenKind
  tokenAccount: string
  tokenOwner: string
  amountRaw: bigint
}

interface MarginPoolLite {
  address: string
  depositNoteMint: string
  loanNoteMint: string
  tokenMint: string
  depositNoteExchangeRate: bigint
  loanNoteExchangeRate: bigint
}

function hasDiscriminator(data: Uint8Array, discriminatorB64: string): boolean {
  const expected = Buffer.from(discriminatorB64, 'base64')
  if (data.length < expected.length) return false
  for (let idx = 0; idx < expected.length; idx++) {
    if (data[idx] !== expected[idx]) return false
  }
  return true
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (offset + PUBKEY_SIZE > data.length) return null
  return new PublicKey(data.slice(offset, offset + PUBKEY_SIZE)).toBase58()
}

function decodeMarginAccount(account: SolanaAccount): MarginAccountLite | null {
  if (!hasDiscriminator(account.data, MARGIN_ACCOUNT_DISC_B64)) return null

  const owner = readPubkey(account.data, OWNER_OFFSET)
  const airspace = readPubkey(account.data, AIRSPACE_OFFSET)
  const liquidator = readPubkey(account.data, LIQUIDATOR_OFFSET)

  if (!owner || !airspace || !liquidator) return null

  return {
    address: account.address,
    owner,
    airspace,
    liquidator,
  }
}

function decodeTokenKind(value: number): TokenKind | null {
  switch (value) {
    case 0:
      return 'Collateral'
    case 1:
      return 'Claim'
    case 2:
      return 'AdapterCollateral'
    default:
      return null
  }
}

function decodeTokenConfig(account: SolanaAccount): TokenConfigLite | null {
  if (!hasDiscriminator(account.data, TOKEN_CONFIG_DISC_B64)) return null
  if (account.data.length <= TOKEN_CONFIG_KIND_OFFSET) return null

  const mint = readPubkey(account.data, TOKEN_CONFIG_MINT_OFFSET)
  const airspace = readPubkey(account.data, TOKEN_CONFIG_AIRSPACE_OFFSET)
  const kind = decodeTokenKind(account.data[TOKEN_CONFIG_KIND_OFFSET] ?? 255)

  if (!mint || !airspace || !kind) return null

  return {
    mint,
    airspace,
    kind,
  }
}

function decodeMarginPool(account: SolanaAccount): MarginPoolLite | null {
  if (!hasDiscriminator(account.data, MARGIN_POOL_DISC_B64)) return null

  const depositNoteMint = readPubkey(
    account.data,
    MARGIN_POOL_DEPOSIT_NOTE_MINT_OFFSET,
  )
  const loanNoteMint = readPubkey(
    account.data,
    MARGIN_POOL_LOAN_NOTE_MINT_OFFSET,
  )
  const tokenMint = readPubkey(account.data, MARGIN_POOL_TOKEN_MINT_OFFSET)
  const borrowedTokens = readGlowNumber(
    account.data,
    MARGIN_POOL_BORROWED_TOKENS_OFFSET,
  )
  const uncollectedFees = readGlowNumber(
    account.data,
    MARGIN_POOL_UNCOLLECTED_FEES_OFFSET,
  )
  const depositTokens = readU64(account.data, MARGIN_POOL_DEPOSIT_TOKENS_OFFSET)
  const depositNotes = readU64(account.data, MARGIN_POOL_DEPOSIT_NOTES_OFFSET)
  const loanNotes = readU64(account.data, MARGIN_POOL_LOAN_NOTES_OFFSET)

  if (
    !depositNoteMint ||
    !loanNoteMint ||
    !tokenMint ||
    borrowedTokens === null ||
    uncollectedFees === null ||
    depositTokens === null ||
    depositNotes === null ||
    loanNotes === null
  ) {
    return null
  }

  const totalValue = borrowedTokens + depositTokens * GLOW_NUMBER_SCALE
  const totalValueWithoutFees =
    totalValue > uncollectedFees ? totalValue - uncollectedFees : 0n
  const depositRateNumerator =
    totalValueWithoutFees > GLOW_NUMBER_SCALE
      ? totalValueWithoutFees
      : GLOW_NUMBER_SCALE
  const depositNotesDenominator = depositNotes > 1n ? depositNotes : 1n
  const loanRateNumerator =
    borrowedTokens > GLOW_NUMBER_SCALE ? borrowedTokens : GLOW_NUMBER_SCALE
  const loanNotesDenominator = loanNotes > 1n ? loanNotes : 1n

  return {
    address: account.address,
    depositNoteMint,
    loanNoteMint,
    tokenMint,
    depositNoteExchangeRate: depositRateNumerator / depositNotesDenominator,
    loanNoteExchangeRate: loanRateNumerator / loanNotesDenominator,
  }
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (offset + U64_SIZE > data.length) return null
  let value = 0n
  for (let idx = 0; idx < U64_SIZE; idx++) {
    value |= BigInt(data[offset + idx] ?? 0) << (8n * BigInt(idx))
  }
  return value
}

function readGlowNumber(data: Uint8Array, offset: number): bigint | null {
  if (offset + GLOW_NUMBER_SIZE > data.length) return null
  let value = 0n
  for (let idx = 0; idx < GLOW_NUMBER_SIZE; idx++) {
    value |= BigInt(data[offset + idx] ?? 0) << (8n * BigInt(idx))
  }
  return value
}

function convertNoteAmountToUnderlying(
  noteAmountRaw: bigint,
  exchangeRate: bigint,
): bigint {
  return (noteAmountRaw * exchangeRate) / GLOW_NUMBER_SCALE
}

function toAccountInfo(account: SolanaAccount): AccountInfo<Buffer> {
  return {
    data: Buffer.from(account.data),
    executable: false,
    lamports: Number(account.lamports),
    owner: new PublicKey(account.programAddress),
    rentEpoch: 0,
  }
}

function decodeTokenBalance(
  account: SolanaAccount,
): { mint: string; owner: string; amount: bigint } | null {
  try {
    const decoded = unpackAccount(
      new PublicKey(account.address),
      toAccountInfo(account),
      new PublicKey(account.programAddress),
    )
    return {
      mint: decoded.mint.toBase58(),
      owner: decoded.owner.toBase58(),
      amount: decoded.amount,
    }
  } catch {
    return null
  }
}

function decodeMintDecimals(account: SolanaAccount): number | undefined {
  try {
    const decoded = unpackMint(
      new PublicKey(account.address),
      toAccountInfo(account),
      new PublicKey(account.programAddress),
    )
    return decoded.decimals
  } catch {
    return undefined
  }
}

function buildPdaAddress(
  programId: string,
  marginAccount: string,
  mint: string,
): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(marginAccount).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(programId),
  )[0].toBase58()
}

function buildPositionValue(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  plugins: SolanaPlugins,
): LendingSuppliedAsset {
  const token = plugins.tokens.get(mint)
  const priceUsd = token?.priceUsd
  const usdValue =
    priceUsd !== undefined && amountRaw <= BigInt(Number.MAX_SAFE_INTEGER)
      ? ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
      : undefined

  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function groupTokenConfigsByAirspace(
  tokenConfigs: TokenConfigLite[],
): Map<string, TokenConfigLite[]> {
  const grouped = new Map<string, Map<string, TokenConfigLite>>()

  for (const tokenConfig of tokenConfigs) {
    let byMint = grouped.get(tokenConfig.airspace)
    if (!byMint) {
      byMint = new Map<string, TokenConfigLite>()
      grouped.set(tokenConfig.airspace, byMint)
    }

    // Keep one config per mint/airspace to avoid duplicate PDA derivations.
    if (!byMint.has(tokenConfig.mint)) {
      byMint.set(tokenConfig.mint, tokenConfig)
    }
  }

  return new Map(
    [...grouped.entries()].map(([airspace, byMint]) => [
      airspace,
      [...byMint.values()],
    ]),
  )
}

export const glowIntegration: SolanaIntegration = {
  platformId: 'glow',

  getUserPositions: async function* (
    address: string,
    plugins: SolanaPlugins,
  ): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = plugins.tokens.get(token)
        if (tokenData === undefined) return undefined
        if (tokenData.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    const marginAccountsMap = yield {
      kind: 'getProgramAccounts' as const,
      programId: MARGIN_PROGRAM_ID,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: MARGIN_ACCOUNT_DISC_B64,
            encoding: 'base64',
          },
        },
        {
          memcmp: {
            offset: OWNER_OFFSET,
            bytes: address,
            encoding: 'base58',
          },
        },
      ],
    }

    const marginAccounts: MarginAccountLite[] = []
    for (const account of Object.values(marginAccountsMap)) {
      if (!account.exists) continue
      const decoded = decodeMarginAccount(account)
      if (!decoded) continue
      if (decoded.owner !== address) continue
      marginAccounts.push(decoded)
    }

    if (marginAccounts.length === 0) return []

    const round1Map = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: MARGIN_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: TOKEN_CONFIG_DISC_B64,
              encoding: 'base64',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: MARGIN_POOL_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: MARGIN_POOL_DISC_B64,
              encoding: 'base64',
            },
          },
        ],
      },
    ]

    const tokenConfigs: TokenConfigLite[] = []

    const noteMintToUnderlyingMint = new Map<string, string>()
    const noteMintToPool = new Map<string, string>()
    const noteMintToExchangeRate = new Map<string, bigint>()

    for (const account of Object.values(round1Map)) {
      if (!account.exists) continue
      const decodedTokenConfig = decodeTokenConfig(account)
      if (decodedTokenConfig) {
        tokenConfigs.push(decodedTokenConfig)
        continue
      }

      const decodedMarginPool = decodeMarginPool(account)
      if (!decodedMarginPool) continue

      noteMintToUnderlyingMint.set(
        decodedMarginPool.depositNoteMint,
        decodedMarginPool.tokenMint,
      )
      noteMintToUnderlyingMint.set(
        decodedMarginPool.loanNoteMint,
        decodedMarginPool.tokenMint,
      )
      noteMintToPool.set(
        decodedMarginPool.depositNoteMint,
        decodedMarginPool.address,
      )
      noteMintToPool.set(
        decodedMarginPool.loanNoteMint,
        decodedMarginPool.address,
      )
      noteMintToExchangeRate.set(
        decodedMarginPool.depositNoteMint,
        decodedMarginPool.depositNoteExchangeRate,
      )
      noteMintToExchangeRate.set(
        decodedMarginPool.loanNoteMint,
        decodedMarginPool.loanNoteExchangeRate,
      )
    }

    if (tokenConfigs.length === 0) return []

    const tokenConfigsByAirspace = groupTokenConfigsByAirspace(tokenConfigs)
    const derivedTokenAccounts: DerivedTokenAccount[] = []
    for (const marginAccount of marginAccounts) {
      const configs = tokenConfigsByAirspace.get(marginAccount.airspace) ?? []
      for (const tokenConfig of configs) {
        const programId =
          tokenConfig.kind === 'Claim'
            ? MARGIN_POOL_PROGRAM_ID
            : MARGIN_PROGRAM_ID

        derivedTokenAccounts.push({
          marginAccount: marginAccount.address,
          mint: tokenConfig.mint,
          kind: tokenConfig.kind,
          tokenAccount: buildPdaAddress(
            programId,
            marginAccount.address,
            tokenConfig.mint,
          ),
        })
      }
    }

    if (derivedTokenAccounts.length === 0) return []

    const tokenAccountAddresses = [
      ...new Set(derivedTokenAccounts.map((entry) => entry.tokenAccount)),
    ]
    const decodedBalances: DecodedTokenBalance[] = []
    const mintAddressesSet = new Set<string>()

    for (const derived of derivedTokenAccounts) {
      mintAddressesSet.add(derived.mint)
      const underlyingMint = noteMintToUnderlyingMint.get(derived.mint)
      if (underlyingMint) {
        mintAddressesSet.add(underlyingMint)
      }
    }
    const mintAddresses = [...mintAddressesSet]

    const round2Addresses = [
      ...new Set([...tokenAccountAddresses, ...mintAddresses]),
    ]
    const round2Map = yield round2Addresses

    for (const derived of derivedTokenAccounts) {
      const account = round2Map[derived.tokenAccount]
      if (!account?.exists) continue

      const decoded = decodeTokenBalance(account)
      if (!decoded || decoded.amount <= 0n) continue
      if (decoded.mint !== derived.mint) continue

      decodedBalances.push({
        marginAccount: derived.marginAccount,
        mint: derived.mint,
        kind: derived.kind,
        tokenAccount: derived.tokenAccount,
        tokenOwner: decoded.owner,
        amountRaw: decoded.amount,
      })
    }

    if (decodedBalances.length === 0) return []

    const decimalsByMint = new Map<string, number>()

    for (const mint of mintAddresses) {
      const account = round2Map[mint]
      if (!account?.exists) continue
      const decimals = decodeMintDecimals(account)
      if (decimals !== undefined) {
        decimalsByMint.set(mint, decimals)
      }
    }

    const balancesByMarginAccount = new Map<string, DecodedTokenBalance[]>()
    for (const balance of decodedBalances) {
      const list = balancesByMarginAccount.get(balance.marginAccount) ?? []
      list.push(balance)
      balancesByMarginAccount.set(balance.marginAccount, list)
    }

    const positions: UserDefiPosition[] = []

    for (const marginAccount of marginAccounts) {
      const balances = balancesByMarginAccount.get(marginAccount.address) ?? []
      if (balances.length === 0) continue

      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []

      balances.sort((left, right) => left.mint.localeCompare(right.mint))

      for (const balance of balances) {
        const displayMint =
          noteMintToUnderlyingMint.get(balance.mint) ?? balance.mint
        const exchangeRate = noteMintToExchangeRate.get(balance.mint)
        const displayAmountRaw =
          exchangeRate !== undefined
            ? convertNoteAmountToUnderlying(balance.amountRaw, exchangeRate)
            : balance.amountRaw
        const decimals =
          decimalsByMint.get(displayMint) ??
          plugins.tokens.get(displayMint)?.decimals ??
          decimalsByMint.get(balance.mint) ??
          plugins.tokens.get(balance.mint)?.decimals ??
          0

        const value = buildPositionValue(
          displayMint,
          displayAmountRaw,
          decimals,
          plugins,
        )

        if (balance.kind === 'Claim') {
          borrowed.push(value)
        } else {
          supplied.push(value)
        }
      }

      if (supplied.length === 0 && borrowed.length === 0) continue

      positions.push({
        platformId: 'glow',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        meta: {
          glow: {
            marginAccount: marginAccount.address,
            owner: marginAccount.owner,
            airspace: marginAccount.airspace,
            liquidator: marginAccount.liquidator,
            noteAccounts: balances.map((balance) => ({
              kind: balance.kind,
              mint: noteMintToUnderlyingMint.get(balance.mint) ?? balance.mint,
              noteMint: balance.mint,
              pool: noteMintToPool.get(balance.mint),
              exchangeRate: noteMintToExchangeRate
                .get(balance.mint)
                ?.toString(),
              tokenAccount: balance.tokenAccount,
              tokenOwner: balance.tokenOwner,
              amountRaw: balance.amountRaw.toString(),
              underlyingAmountRaw: (noteMintToExchangeRate.has(balance.mint)
                ? convertNoteAmountToUnderlying(
                    balance.amountRaw,
                    noteMintToExchangeRate.get(balance.mint) ?? 0n,
                  )
                : balance.amountRaw
              ).toString(),
            })),
          },
        },
      } satisfies LendingDefiPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: MARGIN_PROGRAM_ID,
      discriminator: MARGIN_ACCOUNT_DISCRIMINATOR,
      ownerOffset: OWNER_OFFSET,
    },
  ],
}

export default glowIntegration
