import { BorshAccountsCoder } from '@coral-xyz/anchor'
import { unpackMint } from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type {
  PositionValue,
  ProgramRequest,
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  TradingDefiPosition,
  TradingMarketPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'
import wasabiIdl from './idls/wasabi.json'

type WasabiIdl = {
  address: string
  accounts?: Array<{ name: string; discriminator?: number[] }>
}

type DecodedPosition = {
  trader: PublicKey
  currency: PublicKey
  collateral: PublicKey
  last_funding_timestamp: { toString(): string }
  down_payment: { toString(): string }
  principal: { toString(): string }
  collateral_amount: { toString(): string }
  fees_to_be_paid: { toString(): string }
  collateral_vault: PublicKey
  lp_vault: PublicKey
}

type DecodedBasePool = {
  collateral: PublicKey
  collateral_vault: PublicKey
  currency: PublicKey
  currency_vault: PublicKey
  is_long_pool: boolean
}

type MatchedPool = {
  address: string
  isLong: boolean
}

const wasabiCoder = new BorshAccountsCoder(wasabiIdl as never)

const WASABI_PROGRAM_ID = wasabiIdl.address
const POSITION_OWNER_OFFSET = 8
const BASE_POOL_COLLATERAL_VAULT_OFFSET = 40

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'
export const PROGRAM_IDS = [WASABI_PROGRAM_ID] as const

function accountDiscriminatorBase64(
  idl: WasabiIdl,
  accountName: string,
): string {
  const discriminator = idl.accounts?.find(
    (account) => account.name === accountName,
  )?.discriminator
  if (!discriminator || discriminator.length === 0) {
    throw new Error(`Missing discriminator for account "${accountName}"`)
  }
  return Buffer.from(discriminator).toString('base64')
}

const POSITION_DISC_B64 = accountDiscriminatorBase64(wasabiIdl, 'Position')
const POSITION_DISC = Uint8Array.from(Buffer.from(POSITION_DISC_B64, 'base64'))
const BASE_POOL_DISC_B64 = accountDiscriminatorBase64(wasabiIdl, 'BasePool')

function toBigInt(value: { toString(): string }): bigint {
  return BigInt(value.toString())
}

function divideToDecimalString(
  numerator: bigint,
  denominator: bigint,
  digits = 6,
): string {
  if (denominator === 0n) return '0'

  const negative = numerator < 0n !== denominator < 0n
  const absNum = numerator < 0n ? -numerator : numerator
  const absDen = denominator < 0n ? -denominator : denominator

  const integerPart = absNum / absDen
  const remainder = absNum % absDen
  if (digits <= 0 || remainder === 0n) {
    return `${negative ? '-' : ''}${integerPart}`
  }

  const scale = 10n ** BigInt(digits)
  const fractionalPart = (remainder * scale) / absDen
  const trimmed = fractionalPart
    .toString()
    .padStart(digits, '0')
    .replace(/0+$/, '')

  if (trimmed.length === 0) {
    return `${negative ? '-' : ''}${integerPart}`
  }

  return `${negative ? '-' : ''}${integerPart}.${trimmed}`
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

function buildPositionValue(
  token: string,
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): PositionValue {
  const usdValue = buildUsdValue(amountRaw, decimals, priceUsd)
  return {
    amount: {
      token,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function toFixedDecimal(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

function decodeMintDecimals(account: SolanaAccount): number | undefined {
  try {
    const mint = unpackMint(
      new PublicKey(account.address),
      {
        data: Buffer.from(account.data),
        owner: new PublicKey(account.programAddress),
        lamports: Number(account.lamports),
        executable: false,
      } satisfies AccountInfo<Buffer>,
      new PublicKey(account.programAddress),
    )
    return mint.decimals
  } catch {
    return undefined
  }
}

export const wasabiIntegration: SolanaIntegration = {
  platformId: 'wasabi',

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

    const discovered = yield {
      kind: 'getProgramAccounts' as const,
      programId: WASABI_PROGRAM_ID,
      filters: [
        { memcmp: { offset: 0, bytes: POSITION_DISC_B64, encoding: 'base64' } },
        {
          memcmp: {
            offset: POSITION_OWNER_OFFSET,
            bytes: address,
            encoding: 'base58',
          },
        },
      ],
    }

    const positions: Array<{
      accountAddress: string
      decoded: DecodedPosition
      downPayment: bigint
      principal: bigint
      collateralAmount: bigint
      feesToBePaid: bigint
      lastFundingTimestamp: bigint
    }> = []
    const mintSet = new Set<string>()
    const collateralVaultSet = new Set<string>()

    for (const [accountAddress, account] of Object.entries(discovered)) {
      if (!account?.exists) continue
      try {
        const decoded = wasabiCoder.decode(
          'Position',
          Buffer.from(account.data),
        ) as DecodedPosition
        const downPayment = toBigInt(decoded.down_payment)
        const principal = toBigInt(decoded.principal)
        const collateralAmount = toBigInt(decoded.collateral_amount)
        const feesToBePaid = toBigInt(decoded.fees_to_be_paid)
        const lastFundingTimestamp = BigInt(
          decoded.last_funding_timestamp.toString(),
        )

        if (
          downPayment <= 0n &&
          principal <= 0n &&
          collateralAmount <= 0n &&
          feesToBePaid <= 0n
        ) {
          continue
        }

        positions.push({
          accountAddress,
          decoded,
          downPayment,
          principal,
          collateralAmount,
          feesToBePaid,
          lastFundingTimestamp,
        })
        mintSet.add(decoded.currency.toBase58())
        mintSet.add(decoded.collateral.toBase58())
        collateralVaultSet.add(decoded.collateral_vault.toBase58())
      } catch {
        // Skip malformed accounts and keep scanning.
      }
    }

    if (positions.length === 0) return []

    const mintAddresses = [...mintSet]
    const mintsMap = mintAddresses.length > 0 ? yield mintAddresses : {}
    const mintDecimals = new Map<string, number>()

    for (const mintAddress of mintAddresses) {
      const mintAccount = mintsMap[mintAddress]
      if (!mintAccount?.exists) continue
      const decimals = decodeMintDecimals(mintAccount)
      if (decimals !== undefined) {
        mintDecimals.set(mintAddress, decimals)
      }
    }

    const poolRequests: ProgramRequest[] = [...collateralVaultSet].map(
      (collateralVault) => ({
        kind: 'getProgramAccounts' as const,
        programId: WASABI_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: BASE_POOL_DISC_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: BASE_POOL_COLLATERAL_VAULT_OFFSET,
              bytes: collateralVault,
              encoding: 'base58',
            },
          },
        ],
      }),
    )

    const poolsMap = poolRequests.length > 0 ? yield poolRequests : {}
    const matchedPools = new Map<string, MatchedPool[]>()

    for (const [poolAddress, account] of Object.entries(poolsMap)) {
      if (!account?.exists) continue
      try {
        const decoded = wasabiCoder.decode(
          'BasePool',
          Buffer.from(account.data),
        ) as DecodedBasePool
        const collateralVault = decoded.collateral_vault.toBase58()
        const list = matchedPools.get(collateralVault) ?? []
        list.push({
          address: poolAddress,
          isLong: decoded.is_long_pool,
        })
        matchedPools.set(collateralVault, list)
      } catch {
        // Skip malformed accounts and keep scanning.
      }
    }

    const result: UserDefiPosition[] = []

    for (const position of positions) {
      const decoded = position.decoded
      const currencyMint = decoded.currency.toBase58()
      const collateralMint = decoded.collateral.toBase58()
      const collateralVault = decoded.collateral_vault.toBase58()
      const lpVault = decoded.lp_vault.toBase58()

      const currencyToken = tokens.get(currencyMint)
      const collateralToken = tokens.get(collateralMint)
      const currencyDecimals =
        mintDecimals.get(currencyMint) ?? currencyToken?.decimals ?? 0
      const collateralDecimals =
        mintDecimals.get(collateralMint) ?? collateralToken?.decimals ?? 0

      const matchingPool = (matchedPools.get(collateralVault) ?? [])[0]
      const side = matchingPool?.isLong ? 'long' : 'short'

      // Wasabi encodes long/short notionals differently. For shorts, `principal`
      // is the borrowed base asset amount (e.g. TRUMP), while collateral stays in
      // quote (e.g. SOL). For longs, size is the acquired collateral amount.
      const sideAwareSize =
        side === 'short'
          ? buildPositionValue(
              currencyMint,
              position.principal,
              currencyDecimals,
              currencyToken?.priceUsd,
            )
          : buildPositionValue(
              collateralMint,
              position.collateralAmount,
              collateralDecimals,
              collateralToken?.priceUsd,
            )
      const sideAwareCollateral =
        side === 'short'
          ? buildPositionValue(
              collateralMint,
              position.downPayment,
              collateralDecimals,
              collateralToken?.priceUsd,
            )
          : buildPositionValue(
              currencyMint,
              position.downPayment,
              currencyDecimals,
              currencyToken?.priceUsd,
            )

      const shortLeverage =
        side === 'short' && position.downPayment > 0n
          ? divideToDecimalString(
              position.collateralAmount - position.downPayment,
              position.downPayment,
              3,
            )
          : undefined
      const longLeverage =
        side === 'long' && position.downPayment > 0n
          ? divideToDecimalString(
              position.downPayment + position.principal,
              position.downPayment,
              3,
            )
          : undefined
      const computedLeverage = shortLeverage ?? longLeverage

      let entryPrice: string | undefined
      if (side === 'short' && position.principal > 0n) {
        const proceeds = position.collateralAmount - position.downPayment
        if (proceeds > 0n) {
          const proceedsNum = Number(proceeds) / 10 ** collateralDecimals
          const principalNum =
            Number(position.principal) / 10 ** currencyDecimals
          if (
            Number.isFinite(proceedsNum) &&
            Number.isFinite(principalNum) &&
            principalNum > 0
          ) {
            entryPrice = toFixedDecimal(proceedsNum / principalNum, 6)
          }
        }
      }

      const marketPosition: TradingMarketPosition = {
        ...(matchingPool && { side }),
        size: sideAwareSize,
        ...(sideAwareSize.usdValue && { notionalUsd: sideAwareSize.usdValue }),
        ...(computedLeverage && { leverage: computedLeverage }),
        ...(entryPrice && { entryPrice }),
        collateral: [sideAwareCollateral],
      }

      const tradingPosition: TradingDefiPosition = {
        platformId: 'wasabi',
        positionKind: 'trading',
        marketType: 'perp',
        marginEnabled: true,
        positions: [marketPosition],
        ...(sideAwareCollateral.usdValue && {
          usdValue: sideAwareCollateral.usdValue,
        }),
        meta: {
          position: {
            address: position.accountAddress,
            trader: decoded.trader.toBase58(),
            lpVault,
            collateralVault,
            principalRaw: position.principal.toString(),
            feesToBePaidRaw: position.feesToBePaid.toString(),
            lastFundingTimestamp: position.lastFundingTimestamp.toString(),
            ...(matchingPool && {
              poolAddress: matchingPool.address,
            }),
          },
        },
      }

      result.push(tradingPosition)
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)

    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: WASABI_PROGRAM_ID,
      discriminator: POSITION_DISC,
      ownerOffset: POSITION_OWNER_OFFSET,
    },
  ],
}

export default wasabiIntegration
