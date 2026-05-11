import { createHash } from 'node:crypto'
import { BorshCoder } from '@coral-xyz/anchor'
import {
  CustomBorshAccountsCoder,
  DRIFT_PROGRAM_ID,
  decodeUser,
  getSpotMarketPublicKeySync,
  getTokenAmount,
  type SpotMarketAccount,
  type SpotPosition,
} from '@drift-labs/sdk'
import driftIdl from '@drift-labs/sdk/src/idl/drift.json'
import { MARGINFI_IDL } from '@mrgnlabs/marginfi-client-v2'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'
import lendingIdl from '../jupiter-lend/idls/lending.json'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const LULO_PROGRAM_ID = 'FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q'
const MARGINFI_PROGRAM_ID = 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA'
const JUPITER_LENDING_PROGRAM_ID = lendingIdl.address
const LULO_PROGRAM_KEY = new PublicKey(LULO_PROGRAM_ID)
const DRIFT_PROGRAM_KEY = new PublicKey(DRIFT_PROGRAM_ID)
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'
const DRIFT_USER_DISCRIMINATOR_B64 = Buffer.from(
  createHash('sha256').update('account:User').digest().subarray(0, 8),
).toString('base64')
const JUPITER_LENDING_DISCRIMINATOR_B64 = accountDiscriminatorBase64(
  lendingIdl as {
    accounts?: Array<{ name: string; discriminator?: number[] }>
  },
  'Lending',
)
const JUPITER_EXCHANGE_PRECISION = 1_000_000_000_000n
const DRIFT_USER_AUTHORITY_OFFSET = 8
const LULO_USER_ACCOUNT_OWNER_OFFSET = 16
const LULO_USER_ACCOUNT_MARGINFI_OFFSET = 48
const LULO_USER_ACCOUNT_SIZE = 336
const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const TOKEN_ACCOUNT_AMOUNT_BYTES = 8
const I80F48_FRACTION_BITS = 48n
const I80F48_SCALE = 1n << I80F48_FRACTION_BITS
const I80F48_SCALE_SQUARED = I80F48_SCALE * I80F48_SCALE

const driftAccountsCoder = new CustomBorshAccountsCoder(driftIdl as never)
const jupiterLendingCoder = new BorshCoder(lendingIdl as never)
const marginfiCoder = new BorshCoder(MARGINFI_IDL as never)

type LuloRoute = 'drift' | 'jupiter' | 'marginfi'

const DIRECT_ROUTE_MINTS = {
  drift: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  jupiter: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
} as const satisfies Record<Exclude<LuloRoute, 'marginfi'>, string>

export const PROGRAM_IDS = [
  LULO_PROGRAM_ID,
  DRIFT_PROGRAM_ID,
  JUPITER_LENDING_PROGRAM_ID,
  MARGINFI_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

interface WrappedI80F48 {
  value: number[] | Uint8Array
}

interface MarginfiBalanceRaw {
  active: number
  bank_pk: PublicKey
  asset_shares: WrappedI80F48
  liability_shares: WrappedI80F48
}

interface MarginfiAccountRaw {
  lending_account: {
    balances: MarginfiBalanceRaw[]
  }
}

interface MarginfiBankRaw {
  mint: PublicKey
  mint_decimals: number
  asset_share_value: WrappedI80F48
  liability_share_value: WrappedI80F48
}

interface JupiterLendingPoolRaw {
  mint: PublicKey
  f_token_mint: PublicKey
  decimals: number
  token_exchange_price: {
    toString(): string
  }
}

function accountDiscriminatorBase64(
  idl: { accounts?: Array<{ name: string; discriminator?: number[] }> },
  accountName: string,
) {
  const discriminator = idl.accounts?.find(
    (account) => account.name === accountName,
  )?.discriminator

  if (!discriminator) {
    throw new Error(`Missing discriminator for account "${accountName}"`)
  }

  return Buffer.from(discriminator).toString('base64')
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset)
}

function readTokenAccountMint(data: Uint8Array): string | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_MINT_OFFSET + 32) return null
  return readPubkey(buf, TOKEN_ACCOUNT_MINT_OFFSET)
}

function readTokenAccountAmount(data: Uint8Array): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + TOKEN_ACCOUNT_AMOUNT_BYTES) {
    return null
  }
  return readU64LE(buf, TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function decodeSignedI128LE(bytes: number[] | Uint8Array): bigint {
  const buf = Uint8Array.from(bytes)
  let value = 0n

  for (let idx = 0; idx < 16; idx++) {
    value |= BigInt(buf[idx] ?? 0) << (BigInt(idx) * 8n)
  }

  if ((buf[15] ?? 0) & 0x80) {
    value -= 1n << 128n
  }

  return value
}

function wrappedI80F48ToBigInt(value: WrappedI80F48): bigint {
  return decodeSignedI128LE(value.value)
}

function mulDivTrunc(
  numeratorA: bigint,
  numeratorB: bigint,
  denominator: bigint,
) {
  if (denominator === 0n) return 0n

  const negative = numeratorA < 0n !== numeratorB < 0n
  const absA = numeratorA < 0n ? -numeratorA : numeratorA
  const absB = numeratorB < 0n ? -numeratorB : numeratorB
  const quotient = (absA * absB) / denominator

  return negative ? -quotient : quotient
}

function marginfiAssetAmountRaw(
  balance: MarginfiBalanceRaw,
  bank: MarginfiBankRaw,
): bigint {
  return mulDivTrunc(
    wrappedI80F48ToBigInt(balance.asset_shares),
    wrappedI80F48ToBigInt(bank.asset_share_value),
    I80F48_SCALE_SQUARED,
  )
}

function marginfiLiabilityAmountRaw(
  balance: MarginfiBalanceRaw,
  bank: MarginfiBankRaw,
): bigint {
  return mulDivTrunc(
    wrappedI80F48ToBigInt(balance.liability_shares),
    wrappedI80F48ToBigInt(bank.liability_share_value),
    I80F48_SCALE_SQUARED,
  )
}

function deriveLuloUserAccount(owner: PublicKey): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('flexlend'), owner.toBuffer()],
    LULO_PROGRAM_KEY,
  )[0].toBase58()
}

function parseLuloUserAccount(
  data: Uint8Array,
): { owner: string; marginfiAccount: string } | null {
  const buf = Buffer.from(data)
  if (buf.length !== LULO_USER_ACCOUNT_SIZE) return null

  return {
    owner: readPubkey(buf, LULO_USER_ACCOUNT_OWNER_OFFSET),
    marginfiAccount: readPubkey(buf, LULO_USER_ACCOUNT_MARGINFI_OFFSET),
  }
}

function buildUsdValue(
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return undefined

  return ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
}

function buildSuppliedAsset(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  tokens: SolanaPlugins['tokens'],
): LendingSuppliedAsset {
  const token = tokens.get(mint)
  const usdValue = buildUsdValue(amountRaw, decimals, token?.priceUsd)

  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function buildBorrowedAsset(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  tokens: SolanaPlugins['tokens'],
): LendingBorrowedAsset {
  const token = tokens.get(mint)
  const usdValue = buildUsdValue(amountRaw, decimals, token?.priceUsd)

  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function buildLuloMeta(
  owner: string,
  userAccount: string,
  route: LuloRoute,
  extra?: Record<string, unknown>,
) {
  return {
    lulo: {
      owner,
      userAccount,
      bucket: 'custom',
      route,
      ...(extra ?? {}),
    },
  }
}

function collectTokenBalancesByMint(
  accounts: Record<
    string,
    { exists: boolean; programAddress?: string; data?: Uint8Array }
  >,
) {
  const balances = new Map<string, bigint>()

  for (const account of Object.values(accounts)) {
    if (!account.exists || !account.data) continue
    if (
      account.programAddress !== TOKEN_PROGRAM_ID.toBase58() &&
      account.programAddress !== TOKEN_2022_PROGRAM_ID.toBase58()
    ) {
      continue
    }

    const mint = readTokenAccountMint(account.data)
    const amount = readTokenAccountAmount(account.data)
    if (!mint || amount === null || amount <= 0n) continue

    const existing = balances.get(mint) ?? 0n
    balances.set(mint, existing + amount)
  }

  return balances
}

function isDriftDepositPosition(position: SpotPosition) {
  return 'deposit' in position.balanceType
}

export const luloIntegration: SolanaIntegration = {
  platformId: 'lulo',

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
    const finalizePositions = (positions: UserDefiPosition[]) => {
      applyPositionsPctUsdValueChange24(tokenSource, positions)
      return positions
    }

    const owner = new PublicKey(address)
    const luloUserAccountAddress = deriveLuloUserAccount(owner)
    const luloUserAccountMap = yield [luloUserAccountAddress]
    const luloUserAccount = luloUserAccountMap[luloUserAccountAddress]

    if (!luloUserAccount?.exists) return []

    const parsedLuloUser = parseLuloUserAccount(luloUserAccount.data)
    if (!parsedLuloUser) return []
    if (parsedLuloUser.owner !== address) return []

    const discoveryAccounts = yield [
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: luloUserAccountAddress,
        programId: TOKEN_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: luloUserAccountAddress,
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: DRIFT_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: DRIFT_USER_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: DRIFT_USER_AUTHORITY_OFFSET,
              bytes: luloUserAccountAddress,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: JUPITER_LENDING_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: JUPITER_LENDING_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
        ],
      },
    ]

    const balancesByMint = collectTokenBalancesByMint(discoveryAccounts)
    const positions: UserDefiPosition[] = []

    const jupiterPools: JupiterLendingPoolRaw[] = []
    for (const account of Object.values(discoveryAccounts)) {
      if (!account.exists || !('data' in account)) continue
      if (account.programAddress !== JUPITER_LENDING_PROGRAM_ID) continue

      try {
        jupiterPools.push(
          jupiterLendingCoder.accounts.decode(
            'Lending',
            Buffer.from(account.data),
          ) as JupiterLendingPoolRaw,
        )
      } catch {
        // Skip pools that fail to decode.
      }
    }

    const jupiterPool = jupiterPools.find(
      (pool) => pool.mint.toBase58() === DIRECT_ROUTE_MINTS.jupiter,
    )

    if (jupiterPool) {
      const shareMint = jupiterPool.f_token_mint.toBase58()
      const shares = balancesByMint.get(shareMint) ?? 0n

      if (shares > 0n) {
        const amountRaw =
          (shares * BigInt(jupiterPool.token_exchange_price.toString())) /
          JUPITER_EXCHANGE_PRECISION

        if (amountRaw > 0n) {
          positions.push({
            platformId: 'lulo',
            positionKind: 'lending',
            supplied: [
              buildSuppliedAsset(
                DIRECT_ROUTE_MINTS.jupiter,
                amountRaw,
                jupiterPool.decimals,
                tokens,
              ),
            ],
            meta: buildLuloMeta(address, luloUserAccountAddress, 'jupiter', {
              shareMint,
            }),
          } satisfies LendingDefiPosition)
        }
      }
    }

    const driftUsers = []
    for (const account of Object.values(discoveryAccounts)) {
      if (!account.exists || !('data' in account)) continue
      if (account.programAddress !== DRIFT_PROGRAM_ID) continue
      if (
        Buffer.from(account.data.subarray(0, 8)).toString('base64') !==
        DRIFT_USER_DISCRIMINATOR_B64
      ) {
        continue
      }

      try {
        driftUsers.push(decodeUser(Buffer.from(account.data)))
      } catch {
        // Skip users that fail to decode.
      }
    }

    const driftMarketAddresses = [
      ...new Set(
        driftUsers.flatMap((user) =>
          user.spotPositions
            .filter(
              (position) => BigInt(position.scaledBalance.toString()) !== 0n,
            )
            .map((position) =>
              getSpotMarketPublicKeySync(
                DRIFT_PROGRAM_KEY,
                position.marketIndex,
              ).toBase58(),
            ),
        ),
      ),
    ]

    const phaseThreeAddresses: string[] = [...driftMarketAddresses]
    if (parsedLuloUser.marginfiAccount !== DEFAULT_PUBLIC_KEY) {
      phaseThreeAddresses.push(parsedLuloUser.marginfiAccount)
    }

    const phaseThreeAccounts =
      phaseThreeAddresses.length > 0 ? yield phaseThreeAddresses : {}

    const driftSpotMarketsByIndex = new Map<number, SpotMarketAccount>()
    for (const marketAddress of driftMarketAddresses) {
      const marketAccount = phaseThreeAccounts[marketAddress]
      if (!marketAccount?.exists || !('data' in marketAccount)) continue

      try {
        const spotMarket = driftAccountsCoder.decode(
          'SpotMarket',
          Buffer.from(marketAccount.data),
        ) as SpotMarketAccount
        driftSpotMarketsByIndex.set(spotMarket.marketIndex, spotMarket)
      } catch {
        // Skip markets that fail to decode.
      }
    }

    let driftAmountRaw = 0n
    let driftDecimals: number | undefined

    for (const user of driftUsers) {
      for (const spotPosition of user.spotPositions) {
        if (BigInt(spotPosition.scaledBalance.toString()) === 0n) continue
        if (!isDriftDepositPosition(spotPosition)) continue

        const spotMarket = driftSpotMarketsByIndex.get(spotPosition.marketIndex)
        if (!spotMarket) continue
        if (spotMarket.mint.toBase58() !== DIRECT_ROUTE_MINTS.drift) continue

        const amountRaw = BigInt(
          getTokenAmount(
            spotPosition.scaledBalance,
            spotMarket,
            spotPosition.balanceType,
          ).toString(),
        )
        if (amountRaw <= 0n) continue

        driftAmountRaw += amountRaw
        driftDecimals = spotMarket.decimals
      }
    }

    if (driftAmountRaw > 0n && driftDecimals !== undefined) {
      positions.push({
        platformId: 'lulo',
        positionKind: 'lending',
        supplied: [
          buildSuppliedAsset(
            DIRECT_ROUTE_MINTS.drift,
            driftAmountRaw,
            driftDecimals,
            tokens,
          ),
        ],
        meta: buildLuloMeta(address, luloUserAccountAddress, 'drift'),
      } satisfies LendingDefiPosition)
    }

    const marginfiAccountAddress = parsedLuloUser.marginfiAccount
    const marginfiAccount = phaseThreeAccounts[marginfiAccountAddress]

    if (!marginfiAccount?.exists || !('data' in marginfiAccount))
      return finalizePositions(positions)

    let decodedMarginfiAccount: MarginfiAccountRaw
    try {
      decodedMarginfiAccount = marginfiCoder.accounts.decode(
        'MarginfiAccount',
        Buffer.from(marginfiAccount.data),
      ) as MarginfiAccountRaw
    } catch {
      return finalizePositions(positions)
    }

    const activeMarginfiBalances =
      decodedMarginfiAccount.lending_account.balances.filter(
        (balance) => balance.active === 1,
      )
    if (activeMarginfiBalances.length === 0) return finalizePositions(positions)

    const bankAddresses = activeMarginfiBalances.map((balance) =>
      balance.bank_pk.toBase58(),
    )
    const marginfiBanks = yield bankAddresses

    const supplied: LendingSuppliedAsset[] = []
    const borrowed: LendingBorrowedAsset[] = []

    for (const balance of activeMarginfiBalances) {
      const bankAddress = balance.bank_pk.toBase58()
      const bankAccount = marginfiBanks[bankAddress]
      if (!bankAccount?.exists) continue

      let bank: MarginfiBankRaw
      try {
        bank = marginfiCoder.accounts.decode(
          'Bank',
          Buffer.from(bankAccount.data),
        ) as MarginfiBankRaw
      } catch {
        continue
      }

      const mint = bank.mint.toBase58()
      const decimals = bank.mint_decimals
      const suppliedRaw = marginfiAssetAmountRaw(balance, bank)
      const borrowedRaw = marginfiLiabilityAmountRaw(balance, bank)

      if (suppliedRaw > 0n) {
        supplied.push(buildSuppliedAsset(mint, suppliedRaw, decimals, tokens))
      }
      if (borrowedRaw > 0n) {
        borrowed.push(buildBorrowedAsset(mint, borrowedRaw, decimals, tokens))
      }
    }

    if (supplied.length > 0 || borrowed.length > 0) {
      positions.push({
        platformId: 'lulo',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        meta: buildLuloMeta(address, luloUserAccountAddress, 'marginfi', {
          marginfiAccount: marginfiAccountAddress,
        }),
      } satisfies LendingDefiPosition)
    }

    return finalizePositions(positions)
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: LULO_PROGRAM_ID,
      ownerOffset: LULO_USER_ACCOUNT_OWNER_OFFSET,
      dataSize: LULO_USER_ACCOUNT_SIZE,
    },
  ],
}

export default luloIntegration
