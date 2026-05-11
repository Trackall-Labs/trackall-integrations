import { createHash } from 'node:crypto'
import { BN } from '@coral-xyz/anchor'
import {
  CustomBorshAccountsCoder,
  calculateBorrowRate,
  calculateDepositRate,
  DRIFT_PROGRAM_ID,
  decodeUser,
  getSpotMarketPublicKeySync,
  getTokenAmount,
  type InsuranceFundStake,
  type SpotMarketAccount,
  type SpotPosition,
  unstakeSharesToAmount,
  unstakeSharesToAmountWithOpenRequest,
} from '@drift-labs/sdk'
import driftIdl from '@drift-labs/sdk/src/idl/drift.json'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

export const testAddress = 'BxTExiVRt9EHe4b47ZDQLDGxee1hPexvkmaDFMLZTDvv'

const DRIFT_PROGRAM_KEY = new PublicKey(DRIFT_PROGRAM_ID)
const USER_DISCRIMINATOR = accountDiscriminator('User')
const INSURANCE_FUND_STAKE_DISCRIMINATOR =
  accountDiscriminator('InsuranceFundStake')
const USER_DISCRIMINATOR_B64 =
  Buffer.from(USER_DISCRIMINATOR).toString('base64')
const INSURANCE_FUND_STAKE_DISCRIMINATOR_B64 = Buffer.from(
  INSURANCE_FUND_STAKE_DISCRIMINATOR,
).toString('base64')
const USER_AUTHORITY_OFFSET = 8
const RATE_PRECISION = 1_000_000n
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const TOKEN_ACCOUNT_AMOUNT_BYTES = 8

export const PROGRAM_IDS = [DRIFT_PROGRAM_ID] as const

const driftAccountsCoder = new CustomBorshAccountsCoder(driftIdl as never)

function accountDiscriminator(accountName: string): Uint8Array {
  return createHash('sha256')
    .update(`account:${accountName}`)
    .digest()
    .subarray(0, 8)
}

function bnToBigInt(value: { toString(): string }): bigint {
  return BigInt(value.toString())
}

function bigIntToBn(value: bigint): BN {
  return new BN(value.toString())
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

function rateToDecimalString(value: { toString(): string }): string {
  return divideToDecimalString(bnToBigInt(value), RATE_PRECISION)
}

function decodeName(rawName: ArrayLike<number>): string | undefined {
  const name = Buffer.from(Array.from(rawName))
    .toString('utf8')
    .replace(/\0+$/g, '')
    .trim()

  return name.length > 0 ? name : undefined
}

function isDepositPosition(position: SpotPosition): boolean {
  return 'deposit' in position.balanceType
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
    ...(priceUsd !== undefined && {
      priceUsd: priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function buildSuppliedAsset(
  market: SpotMarketAccount,
  amountRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): LendingSuppliedAsset {
  const mint = market.mint.toBase58()
  const token = tokens.get(mint)
  const usdValue = buildUsdValue(amountRaw, market.decimals, token?.priceUsd)

  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: market.decimals.toString(),
    },
    supplyRate: rateToDecimalString(calculateDepositRate(market)),
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function buildBorrowedAsset(
  market: SpotMarketAccount,
  amountRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): LendingBorrowedAsset {
  const mint = market.mint.toBase58()
  const token = tokens.get(mint)
  const usdValue = buildUsdValue(amountRaw, market.decimals, token?.priceUsd)

  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: market.decimals.toString(),
    },
    borrowRate: rateToDecimalString(calculateBorrowRate(market)),
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function readTokenAccountAmount(data: Uint8Array): bigint | null {
  if (data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + TOKEN_ACCOUNT_AMOUNT_BYTES) {
    return null
  }

  return Buffer.from(data).readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

function buildInsuranceFundStakePosition(
  stakeAddress: string,
  stake: InsuranceFundStake,
  market: SpotMarketAccount,
  insuranceFundVaultBalanceRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): StakingDefiPosition | null {
  const mint = market.mint.toBase58()
  const token = tokens.get(mint)
  const currentAmountRaw = bnToBigInt(
    unstakeSharesToAmount(
      stake.ifShares,
      market.insuranceFund.totalShares,
      bigIntToBn(insuranceFundVaultBalanceRaw),
    ),
  )

  const pendingWithdrawalRaw =
    bnToBigInt(stake.lastWithdrawRequestShares) > 0n
      ? bnToBigInt(
          unstakeSharesToAmountWithOpenRequest(
            stake.lastWithdrawRequestShares,
            stake.lastWithdrawRequestShares,
            stake.lastWithdrawRequestValue,
            market.insuranceFund.totalShares,
            bigIntToBn(insuranceFundVaultBalanceRaw),
          ),
        )
      : 0n
  const stakedRaw = currentAmountRaw - pendingWithdrawalRaw

  if (stakedRaw <= 0n && pendingWithdrawalRaw <= 0n) {
    return null
  }

  const costBasisRaw = BigInt(stake.costBasis.toString())
  const earningsRaw = currentAmountRaw - costBasisRaw
  const vaultName =
    token?.symbol ?? token?.name ?? decodeName(market.name) ?? mint
  const stakedAsset =
    stakedRaw > 0n
      ? buildPositionValue(mint, stakedRaw, market.decimals, token?.priceUsd)
      : undefined
  const earnings = {
    ...buildPositionValue(mint, earningsRaw, market.decimals, token?.priceUsd),
  }
  const costBasis = {
    ...buildPositionValue(mint, costBasisRaw, market.decimals, token?.priceUsd),
  }

  return {
    platformId: 'drift',
    positionKind: 'staking',
    ...(stakedAsset && { staked: [stakedAsset] }),
    ...(pendingWithdrawalRaw > 0n && {
      unbonding: [
        buildPositionValue(
          mint,
          pendingWithdrawalRaw,
          market.decimals,
          token?.priceUsd,
        ),
      ],
      lockedUntil: (
        BigInt(stake.lastWithdrawRequestTs.toString()) +
        BigInt(market.insuranceFund.unstakingPeriod.toString())
      ).toString(),
      lockDuration: market.insuranceFund.unstakingPeriod.toString(),
    }),
    ...(() => {
      const usdValue = buildUsdValue(
        currentAmountRaw,
        market.decimals,
        token?.priceUsd,
      )
      return usdValue === undefined
        ? {}
        : { totalStakedUsd: usdValue, usdValue }
    })(),
    meta: {
      vault: {
        kind: 'insurance-fund',
        name: vaultName,
        marketIndex: stake.marketIndex,
        stakeAccount: stakeAddress,
      },
      earnings,
      costBasis,
    },
  }
}

export const driftIntegration: SolanaIntegration = {
  platformId: 'drift',

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

    const authority = new PublicKey(address)

    const driftAuthorityAccountsMap = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: DRIFT_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: USER_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: USER_AUTHORITY_OFFSET,
              bytes: authority.toBase58(),
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: DRIFT_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: INSURANCE_FUND_STAKE_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: USER_AUTHORITY_OFFSET,
              bytes: authority.toBase58(),
            },
          },
        ],
      },
    ]

    const users = Object.values(driftAuthorityAccountsMap)
      .filter((account) => account.exists)
      .flatMap((account) => {
        if (
          account.programAddress !== DRIFT_PROGRAM_ID ||
          account.data.length === 0 ||
          Buffer.from(account.data.subarray(0, 8)).toString('base64') !==
            USER_DISCRIMINATOR_B64
        ) {
          return []
        }

        try {
          return [decodeUser(Buffer.from(account.data))]
        } catch {
          return []
        }
      })
    const insuranceFundStakes = Object.values(driftAuthorityAccountsMap)
      .filter((account) => account.exists)
      .flatMap((account) => {
        if (
          account.programAddress !== DRIFT_PROGRAM_ID ||
          account.data.length === 0 ||
          Buffer.from(account.data.subarray(0, 8)).toString('base64') !==
            INSURANCE_FUND_STAKE_DISCRIMINATOR_B64
        ) {
          return []
        }

        try {
          return [
            {
              address: account.address,
              stake: driftAccountsCoder.decode(
                'InsuranceFundStake',
                Buffer.from(account.data),
              ) as InsuranceFundStake,
            },
          ]
        } catch {
          return []
        }
      })

    const activeSpotMarketIndexes = new Set<number>()
    for (const user of users) {
      for (const spotPosition of user.spotPositions) {
        if (bnToBigInt(spotPosition.scaledBalance) === 0n) continue
        activeSpotMarketIndexes.add(spotPosition.marketIndex)
      }
    }
    for (const { stake } of insuranceFundStakes) {
      if (bnToBigInt(stake.ifShares) === 0n) continue
      activeSpotMarketIndexes.add(stake.marketIndex)
    }

    if (activeSpotMarketIndexes.size === 0) return []

    const spotMarketAddresses = [...activeSpotMarketIndexes].map(
      (marketIndex) =>
        getSpotMarketPublicKeySync(DRIFT_PROGRAM_KEY, marketIndex).toBase58(),
    )
    const spotMarketsMap = yield spotMarketAddresses
    const spotMarketsByIndex = new Map<number, SpotMarketAccount>()

    for (const marketAccount of Object.values(spotMarketsMap)) {
      if (!marketAccount.exists) continue
      try {
        const spotMarket = driftAccountsCoder.decode(
          'SpotMarket',
          Buffer.from(marketAccount.data),
        ) as SpotMarketAccount
        spotMarketsByIndex.set(spotMarket.marketIndex, spotMarket)
      } catch {
        // Skip markets that fail to decode.
      }
    }
    const insuranceFundVaultAddresses = [
      ...new Set(
        insuranceFundStakes.flatMap(({ stake }) => {
          const spotMarket = spotMarketsByIndex.get(stake.marketIndex)
          return spotMarket ? [spotMarket.insuranceFund.vault.toBase58()] : []
        }),
      ),
    ]
    const insuranceFundVaultsMap =
      insuranceFundVaultAddresses.length > 0
        ? yield insuranceFundVaultAddresses
        : {}

    const result: UserDefiPosition[] = []

    for (const user of users) {
      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []
      const subaccountName = decodeName(user.name)
      let totalUsdValue = 0
      let hasUsdValue = false

      for (const spotPosition of user.spotPositions) {
        if (bnToBigInt(spotPosition.scaledBalance) === 0n) continue

        const spotMarket = spotMarketsByIndex.get(spotPosition.marketIndex)
        if (!spotMarket) continue

        const amountRaw = bnToBigInt(
          getTokenAmount(
            spotPosition.scaledBalance,
            spotMarket,
            spotPosition.balanceType,
          ),
        )
        if (amountRaw === 0n) continue

        if (isDepositPosition(spotPosition)) {
          const asset = buildSuppliedAsset(spotMarket, amountRaw, tokens)
          supplied.push(asset)
          if (asset.usdValue !== undefined) {
            totalUsdValue += Number(asset.usdValue)
            hasUsdValue = true
          }
        } else {
          const asset = buildBorrowedAsset(spotMarket, amountRaw, tokens)
          borrowed.push(asset)
          if (asset.usdValue !== undefined) {
            totalUsdValue -= Number(asset.usdValue)
            hasUsdValue = true
          }
        }
      }

      if (supplied.length === 0 && borrowed.length === 0) continue

      const position: LendingDefiPosition = {
        platformId: 'drift',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        ...(subaccountName !== undefined && {
          meta: {
            subaccount: {
              name: subaccountName,
            },
          },
        }),
      }

      if (hasUsdValue) {
        position.usdValue = totalUsdValue.toString()
      }

      result.push(position)
    }

    for (const { address: stakeAddress, stake } of insuranceFundStakes) {
      if (bnToBigInt(stake.ifShares) === 0n) continue

      const spotMarket = spotMarketsByIndex.get(stake.marketIndex)
      if (!spotMarket) continue

      const insuranceFundVault =
        insuranceFundVaultsMap[spotMarket.insuranceFund.vault.toBase58()]
      if (!insuranceFundVault?.exists) continue

      const insuranceFundVaultBalanceRaw = readTokenAccountAmount(
        insuranceFundVault.data,
      )
      if (insuranceFundVaultBalanceRaw === null) continue

      const position = buildInsuranceFundStakePosition(
        stakeAddress,
        stake,
        spotMarket,
        insuranceFundVaultBalanceRaw,
        tokens,
      )
      if (position) {
        result.push(position)
      }
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)
    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: DRIFT_PROGRAM_ID,
      discriminator: USER_DISCRIMINATOR,
      ownerOffset: USER_AUTHORITY_OFFSET,
    },
    {
      programId: DRIFT_PROGRAM_ID,
      discriminator: INSURANCE_FUND_STAKE_DISCRIMINATOR,
      ownerOffset: USER_AUTHORITY_OFFSET,
    },
  ],
}

export default driftIntegration
