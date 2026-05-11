import { PublicKey } from '@solana/web3.js'
import type {
  ConstantProductLiquidityDefiPosition,
  MaybeSolanaAccount,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'

const DIVERSIFI_BASKET_PROGRAM_ID =
  '3vyr9DRfMZb2KvUQdnps7YG3PY38XdguLBQaJ2DFkSxk'
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const DIVERSIFI_BASKET_ACCOUNT_SIZE = 246
const DIVERSIFI_BASKET_INDEX_MINT_OFFSET = 33

const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

const MINT_ACCOUNT_DECIMALS_OFFSET = 44
const MINT_ACCOUNT_MINT_AUTHORITY_OPTION_OFFSET = 0
const MINT_ACCOUNT_MINT_AUTHORITY_OFFSET = 4

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  DIVERSIFI_BASKET_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
] as const

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.slice(offset, offset + 32)).toBase58()
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readMintDecimals(
  account: MaybeSolanaAccount | undefined,
): number | null {
  if (!account?.exists) return null
  if (account.programAddress !== TOKEN_PROGRAM_ID) return null
  if (account.data.length <= MINT_ACCOUNT_DECIMALS_OFFSET) return null
  return account.data[MINT_ACCOUNT_DECIMALS_OFFSET] ?? null
}

function readMintAuthority(
  account: MaybeSolanaAccount | undefined,
): string | null {
  if (!account?.exists) return null
  if (account.programAddress !== TOKEN_PROGRAM_ID) return null

  if (account.data.length < MINT_ACCOUNT_MINT_AUTHORITY_OFFSET + 32) return null
  const option = readU64(
    account.data,
    MINT_ACCOUNT_MINT_AUTHORITY_OPTION_OFFSET,
  )
  if (option === null || option === 0n) return null

  return readPubkey(account.data, MINT_ACCOUNT_MINT_AUTHORITY_OFFSET)
}

function toUiAmountString(amountRaw: bigint, decimals: number): string {
  if (decimals <= 0) return amountRaw.toString()

  const scale = 10n ** BigInt(decimals)
  const whole = amountRaw / scale
  const fraction = amountRaw % scale
  if (fraction === 0n) return whole.toString()

  const fractionString = fraction
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  return `${whole.toString()}.${fractionString}`
}

function buildPositionValue(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const value: PositionValue = {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
  }

  if (priceUsd !== undefined) {
    value.priceUsd = priceUsd.toString()
    const uiAmount = Number(toUiAmountString(amountRaw, decimals))
    if (Number.isFinite(uiAmount)) {
      value.usdValue = (uiAmount * priceUsd).toString()
    }
  }

  return value
}

function sumUsdValues(values: Array<string | undefined>): string | undefined {
  const present = values
    .filter((value): value is string => value !== undefined)
    .map(Number)

  if (present.length === 0) return undefined
  return present.reduce((sum, value) => sum + value, 0).toString()
}

export const diversifiIntegration: SolanaIntegration = {
  platformId: 'diversifi',

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

    const wallet = new PublicKey(address)

    const phase0Map = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: DIVERSIFI_BASKET_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [{ dataSize: DIVERSIFI_BASKET_ACCOUNT_SIZE }],
      },
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: wallet.toBase58(),
        programId: TOKEN_PROGRAM_ID,
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]

    const basketByMint = new Map<string, string>()
    const balancesByMint = new Map<string, bigint>()

    for (const account of Object.values(phase0Map)) {
      if (!account.exists) continue

      if (
        account.programAddress === DIVERSIFI_BASKET_PROGRAM_ID &&
        account.data.length === DIVERSIFI_BASKET_ACCOUNT_SIZE
      ) {
        const mint = readPubkey(
          account.data,
          DIVERSIFI_BASKET_INDEX_MINT_OFFSET,
        )
        if (mint) {
          basketByMint.set(mint, account.address)
        }
        continue
      }

      if (account.programAddress !== TOKEN_PROGRAM_ID) continue

      const mint = readPubkey(account.data, TOKEN_ACCOUNT_MINT_OFFSET)
      const amountRaw = readU64(account.data, TOKEN_ACCOUNT_AMOUNT_OFFSET)
      if (!mint || amountRaw === null || amountRaw <= 0n) continue

      balancesByMint.set(mint, (balancesByMint.get(mint) ?? 0n) + amountRaw)
    }

    if (basketByMint.size === 0 || balancesByMint.size === 0) return []

    const candidateMints = [...balancesByMint.keys()].filter((mint) =>
      basketByMint.has(mint),
    )
    if (candidateMints.length === 0) return []

    const mintAccounts = yield candidateMints

    const positions: ConstantProductLiquidityDefiPosition[] = []
    for (const mint of candidateMints) {
      const basketAccount = basketByMint.get(mint)
      const amountRaw = balancesByMint.get(mint)
      if (!basketAccount || amountRaw === undefined) continue

      const mintAccount = mintAccounts[mint]
      const decimals = readMintDecimals(mintAccount)
      const mintAuthority = readMintAuthority(mintAccount)
      if (decimals === null || mintAuthority !== basketAccount) continue

      const tokenInfo = tokens.get(mint)
      const poolToken = buildPositionValue(
        mint,
        amountRaw,
        decimals,
        tokenInfo?.priceUsd,
      )
      const usdValue = sumUsdValues([poolToken.usdValue])

      positions.push({
        platformId: 'diversifi',
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        poolTokens: [poolToken],
        poolAddress: basketAccount,
        lpTokenAmount: toUiAmountString(amountRaw, decimals),
        ...(usdValue !== undefined && { usdValue }),
        meta: {
          diversifi: {
            basketAccount,
            indexTokenMint: mint,
            tokenSymbol: tokenInfo?.symbol ?? null,
            tokenName: tokenInfo?.name ?? null,
          },
        },
      } satisfies ConstantProductLiquidityDefiPosition)
    }

    positions.sort((left, right) => {
      const leftPool = left.poolAddress
      const rightPool = right.poolAddress
      if (!leftPool || !rightPool) return 0
      return leftPool.localeCompare(rightPool)
    })

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions as UserDefiPosition[]
  },

  // Diversifi positions are inferred from generic SPL token ownership.
  // There is no protocol-owned user account with a stable owner offset.
  getUsersFilter: () => [],
}

export default diversifiIntegration
