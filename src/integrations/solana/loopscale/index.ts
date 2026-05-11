import { BorshCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  ProgramRequest,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'
import loopscaleIdl from './idls/loopscale.json'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const LOOPSCALE_IDL_SOURCE_PROGRAM_ID =
  '1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78'
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'
const LOAN_BORROWER_OFFSET = 11
const STRATEGY_LENDER_OFFSET = 74
const VAULT_STAKE_USER_OFFSET = 73
const USER_REWARDS_INFO_USER_OFFSET = 81
const MINT_DECIMALS_OFFSET = 44

type LoopscaleIdl = {
  address: string
  accounts?: Array<{ name: string; discriminator?: number[] }>
}

type LoopscaleAccountMap = Record<
  string,
  {
    exists: boolean
    address: string
    data?: Uint8Array
  }
>

interface LoopscaleLoanAccount {
  address: string
  decoded: {
    borrower: PublicKey
    ledgers: Array<{
      principal_mint: PublicKey
      principal_due: unknown
      principal_repaid: unknown
      interest_outstanding: unknown
    }>
    collateral: Array<{
      asset_mint: PublicKey
      amount: unknown
    }>
  }
}

interface LoopscaleVaultStakeAccount {
  address: string
  decoded: {
    vault: PublicKey
    user: PublicKey
    amount: unknown
  }
}

interface LoopscaleStrategyAccount {
  address: string
  decoded: {
    principal_mint: PublicKey
    lender: PublicKey
    market_information: PublicKey
    token_balance: unknown
    external_yield_amount: unknown
    current_deployed_amount: unknown
    outstanding_interest_amount: unknown
    fee_claimable: unknown
  }
}

interface LoopscaleUserRewardsInfoAccount {
  address: string
  decoded: {
    vault_address: PublicKey
    user: PublicKey
    lp_amount: unknown
  }
}

interface LoopscaleVaultData {
  principalMint: string
  lpMint: string
  lpSupply: bigint
  cumulativePrincipalDeposited: bigint
}

export const PROGRAM_IDS = [LOOPSCALE_IDL_SOURCE_PROGRAM_ID] as const

const loopscaleCoder = new BorshCoder(loopscaleIdl as never)
const LOAN_DISCRIMINATOR = accountDiscriminator(
  loopscaleIdl as LoopscaleIdl,
  'Loan',
)
const VAULT_STAKE_DISCRIMINATOR = accountDiscriminator(
  loopscaleIdl as LoopscaleIdl,
  'VaultStake',
)
const STRATEGY_DISCRIMINATOR = accountDiscriminator(
  loopscaleIdl as LoopscaleIdl,
  'Strategy',
)
const USER_REWARDS_INFO_DISCRIMINATOR = accountDiscriminator(
  loopscaleIdl as LoopscaleIdl,
  'UserRewardsInfo',
)
const LOAN_DISCRIMINATOR_B64 = LOAN_DISCRIMINATOR.toString('base64')
const VAULT_STAKE_DISCRIMINATOR_B64 =
  VAULT_STAKE_DISCRIMINATOR.toString('base64')
const STRATEGY_DISCRIMINATOR_B64 = STRATEGY_DISCRIMINATOR.toString('base64')
const USER_REWARDS_INFO_DISCRIMINATOR_B64 =
  USER_REWARDS_INFO_DISCRIMINATOR.toString('base64')

function accountDiscriminator(idl: LoopscaleIdl, accountName: string): Buffer {
  const discriminator = idl.accounts?.find(
    (account) => account.name === accountName,
  )?.discriminator
  if (!discriminator) {
    throw new Error(`Missing discriminator for account "${accountName}"`)
  }
  return Buffer.from(discriminator)
}

function hasDiscriminator(data: Uint8Array, discriminator: Buffer): boolean {
  return Buffer.from(data).subarray(0, 8).equals(discriminator)
}

function readLittleEndianBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = 0; index < bytes.length; index++) {
    value |= BigInt(bytes[index] ?? 0) << (BigInt(index) * 8n)
  }
  return value
}

function podBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null

  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value)

  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return Uint8Array.from(value)
  }

  if (typeof value === 'object') {
    const tuple = (value as Record<string, unknown>)['0']
    if (tuple !== undefined) {
      return podBytes(tuple)
    }
  }

  return null
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value))
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value)
  }

  const bytes = podBytes(value)
  if (bytes !== null) return readLittleEndianBigInt(bytes)

  if (value !== null && typeof value === 'object') {
    const maybeString = String(value)
    if (/^-?\d+$/.test(maybeString)) {
      return BigInt(maybeString)
    }
  }

  return 0n
}

function parseMintDecimals(data: Uint8Array): number | undefined {
  if (data.length <= MINT_DECIMALS_OFFSET) return undefined
  return data[MINT_DECIMALS_OFFSET]
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

function sumPositionUsdValue(
  supplied: LendingSuppliedAsset[],
  borrowed: LendingBorrowedAsset[],
): string | undefined {
  const suppliedValue = supplied.reduce(
    (sum, asset) => sum + Number(asset.usdValue ?? 0),
    0,
  )
  const borrowedValue = borrowed.reduce(
    (sum, asset) => sum + Number(asset.usdValue ?? 0),
    0,
  )

  if (!Number.isFinite(suppliedValue) || !Number.isFinite(borrowedValue)) {
    return undefined
  }

  if (
    supplied.every((asset) => asset.usdValue === undefined) &&
    borrowed.every((asset) => asset.usdValue === undefined)
  ) {
    return undefined
  }

  return (suppliedValue - borrowedValue).toString()
}

function keyToBase58(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58()
  if (typeof value === 'string') return value

  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toBase58?: unknown }).toBase58 === 'function'
  ) {
    return ((value as { toBase58: () => string }).toBase58() ??
      DEFAULT_PUBLIC_KEY) as string
  }

  return DEFAULT_PUBLIC_KEY
}

function isDefaultKey(address: string): boolean {
  return address === DEFAULT_PUBLIC_KEY
}

function mintDecimals(
  mint: string,
  tokens: SolanaPlugins['tokens'],
  mintDecimalsMap: Map<string, number>,
): number {
  return mintDecimalsMap.get(mint) ?? tokens.get(mint)?.decimals ?? 0
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

function decodeDiscoveredAccounts(discoveryMap: LoopscaleAccountMap): {
  loans: LoopscaleLoanAccount[]
  strategies: LoopscaleStrategyAccount[]
  stakes: LoopscaleVaultStakeAccount[]
  rewardsInfo: LoopscaleUserRewardsInfoAccount[]
} {
  const loans: LoopscaleLoanAccount[] = []
  const strategies: LoopscaleStrategyAccount[] = []
  const stakes: LoopscaleVaultStakeAccount[] = []
  const rewardsInfo: LoopscaleUserRewardsInfoAccount[] = []

  for (const account of Object.values(discoveryMap)) {
    if (!account.exists || !account.data) continue

    try {
      if (hasDiscriminator(account.data, LOAN_DISCRIMINATOR)) {
        const decoded = loopscaleCoder.accounts.decode(
          'Loan',
          Buffer.from(account.data),
        ) as LoopscaleLoanAccount['decoded']
        loans.push({ address: account.address, decoded })
        continue
      }

      if (hasDiscriminator(account.data, VAULT_STAKE_DISCRIMINATOR)) {
        const decoded = loopscaleCoder.accounts.decode(
          'VaultStake',
          Buffer.from(account.data),
        ) as LoopscaleVaultStakeAccount['decoded']
        stakes.push({ address: account.address, decoded })
        continue
      }

      if (hasDiscriminator(account.data, STRATEGY_DISCRIMINATOR)) {
        const decoded = loopscaleCoder.accounts.decode(
          'Strategy',
          Buffer.from(account.data),
        ) as LoopscaleStrategyAccount['decoded']
        strategies.push({ address: account.address, decoded })
        continue
      }

      if (hasDiscriminator(account.data, USER_REWARDS_INFO_DISCRIMINATOR)) {
        const decoded = loopscaleCoder.accounts.decode(
          'UserRewardsInfo',
          Buffer.from(account.data),
        ) as LoopscaleUserRewardsInfoAccount['decoded']
        rewardsInfo.push({ address: account.address, decoded })
      }
    } catch {
      // Skip malformed or unexpected accounts.
    }
  }

  return { loans, strategies, stakes, rewardsInfo }
}

function decodeVaultAccounts(
  vaultAccounts: LoopscaleAccountMap,
): Map<string, LoopscaleVaultData> {
  const map = new Map<string, LoopscaleVaultData>()

  for (const [address, account] of Object.entries(vaultAccounts)) {
    if (!account.exists || !account.data) continue

    try {
      const decoded = loopscaleCoder.accounts.decode(
        'Vault',
        Buffer.from(account.data),
      ) as {
        principal_mint: PublicKey
        lp_mint: PublicKey
        lp_supply: unknown
        cumulative_principal_deposited: unknown
      }

      map.set(address, {
        principalMint: keyToBase58(decoded.principal_mint),
        lpMint: keyToBase58(decoded.lp_mint),
        lpSupply: toBigInt(decoded.lp_supply),
        cumulativePrincipalDeposited: toBigInt(
          decoded.cumulative_principal_deposited,
        ),
      })
    } catch {
      // Skip malformed vault accounts.
    }
  }

  return map
}

function computeStrategyNav(strategy: LoopscaleStrategyAccount): bigint {
  const tokenBalance = toBigInt(strategy.decoded.token_balance)
  const externalYield = toBigInt(strategy.decoded.external_yield_amount)
  const currentDeployed = toBigInt(strategy.decoded.current_deployed_amount)
  const outstandingInterest = toBigInt(
    strategy.decoded.outstanding_interest_amount,
  )
  const feeClaimable = toBigInt(strategy.decoded.fee_claimable)
  return (
    tokenBalance +
    externalYield +
    currentDeployed +
    outstandingInterest -
    feeClaimable
  )
}

function computeVaultPrincipalAmount(
  lpAmount: bigint,
  vault: LoopscaleVaultData,
  vaultTotalNav: bigint | undefined,
): { amount: bigint; source: 'strategy-nav' | 'lp-raw-fallback' } {
  if (
    vaultTotalNav !== undefined &&
    vaultTotalNav > 0n &&
    vault.lpSupply > 0n
  ) {
    return {
      amount: (lpAmount * vaultTotalNav) / vault.lpSupply,
      source: 'strategy-nav',
    }
  }
  return { amount: lpAmount, source: 'lp-raw-fallback' }
}

export const loopscaleIntegration: SolanaIntegration = {
  platformId: 'loopscale',

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

    const discoveryRequests: ProgramRequest[] = [
      {
        kind: 'getProgramAccounts' as const,
        programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: LOAN_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          { memcmp: { offset: LOAN_BORROWER_OFFSET, bytes: address } },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: VAULT_STAKE_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          { memcmp: { offset: VAULT_STAKE_USER_OFFSET, bytes: address } },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: STRATEGY_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          { memcmp: { offset: STRATEGY_LENDER_OFFSET, bytes: address } },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: USER_REWARDS_INFO_DISCRIMINATOR_B64,
              encoding: 'base64',
            },
          },
          {
            memcmp: {
              offset: USER_REWARDS_INFO_USER_OFFSET,
              bytes: address,
            },
          },
        ],
      },
    ]
    const discoveryMap = yield discoveryRequests

    const { loans, strategies, stakes, rewardsInfo } =
      decodeDiscoveredAccounts(discoveryMap)

    const vaultAddresses = [
      ...new Set([
        ...stakes.map((stake) => keyToBase58(stake.decoded.vault)),
        ...rewardsInfo.map((info) => keyToBase58(info.decoded.vault_address)),
      ]),
    ]
    const vaultAccounts = vaultAddresses.length > 0 ? yield vaultAddresses : {}
    const vaults = decodeVaultAccounts(vaultAccounts)

    const vaultTotalNav = new Map<string, bigint>()
    if (vaultAddresses.length > 0) {
      const vaultStrategyRequests: ProgramRequest[] = vaultAddresses.map(
        (vaultAddr) => ({
          kind: 'getProgramAccounts' as const,
          programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
          cacheTtlMs: ONE_HOUR_IN_MS,
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: STRATEGY_DISCRIMINATOR_B64,
                encoding: 'base64',
              },
            },
            { memcmp: { offset: STRATEGY_LENDER_OFFSET, bytes: vaultAddr } },
          ],
        }),
      )
      const vaultStrategyAccounts: LoopscaleAccountMap =
        yield vaultStrategyRequests
      for (const account of Object.values(vaultStrategyAccounts)) {
        if (!account.exists || !account.data) continue
        if (!hasDiscriminator(account.data, STRATEGY_DISCRIMINATOR)) continue
        try {
          const decoded = loopscaleCoder.accounts.decode(
            'Strategy',
            Buffer.from(account.data),
          )
          const vaultAddr = keyToBase58(decoded.lender)
          const strategy: LoopscaleStrategyAccount = {
            address: account.address,
            decoded,
          }
          const nav = computeStrategyNav(strategy)
          if (nav > 0n) {
            vaultTotalNav.set(
              vaultAddr,
              (vaultTotalNav.get(vaultAddr) ?? 0n) + nav,
            )
          }
        } catch {
          // Skip malformed strategy accounts.
        }
      }
    }

    const allMints = new Set<string>()
    for (const loan of loans) {
      for (const ledger of loan.decoded.ledgers) {
        const mint = keyToBase58(ledger.principal_mint)
        if (!isDefaultKey(mint)) allMints.add(mint)
      }
      for (const collateral of loan.decoded.collateral) {
        const mint = keyToBase58(collateral.asset_mint)
        if (!isDefaultKey(mint)) allMints.add(mint)
      }
    }
    for (const vault of vaults.values()) {
      if (!isDefaultKey(vault.principalMint)) allMints.add(vault.principalMint)
      if (!isDefaultKey(vault.lpMint)) allMints.add(vault.lpMint)
    }
    for (const strategy of strategies) {
      const mint = keyToBase58(strategy.decoded.principal_mint)
      if (!isDefaultKey(mint)) allMints.add(mint)
    }

    const mintAddresses = [...allMints]
    const mintAccounts = mintAddresses.length > 0 ? yield mintAddresses : {}
    const mintDecimalsMap = new Map<string, number>()
    for (const [mint, account] of Object.entries(mintAccounts)) {
      if (!account.exists) continue
      const decimals = parseMintDecimals(account.data)
      if (decimals !== undefined) mintDecimalsMap.set(mint, decimals)
    }

    const result: UserDefiPosition[] = []

    for (const loan of loans) {
      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []

      for (const ledger of loan.decoded.ledgers) {
        const mint = keyToBase58(ledger.principal_mint)
        if (isDefaultKey(mint)) continue

        const due = toBigInt(ledger.principal_due)
        const repaid = toBigInt(ledger.principal_repaid)
        const interestOutstanding = toBigInt(ledger.interest_outstanding)
        const principalOutstanding = due > repaid ? due - repaid : 0n
        const debtAmount = principalOutstanding + interestOutstanding
        if (debtAmount <= 0n) continue

        borrowed.push(
          buildBorrowedAsset(
            mint,
            debtAmount,
            mintDecimals(mint, tokens, mintDecimalsMap),
            tokens,
          ),
        )
      }

      for (const collateral of loan.decoded.collateral) {
        const mint = keyToBase58(collateral.asset_mint)
        if (isDefaultKey(mint)) continue

        const amount = toBigInt(collateral.amount)
        if (amount <= 0n) continue

        supplied.push(
          buildSuppliedAsset(
            mint,
            amount,
            mintDecimals(mint, tokens, mintDecimalsMap),
            tokens,
          ),
        )
      }

      if (supplied.length === 0 && borrowed.length === 0) continue

      const position: LendingDefiPosition = {
        platformId: 'loopscale',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        meta: {
          loopscale: {
            source: 'loan',
            account: loan.address,
          },
        },
      }

      const usdValue = sumPositionUsdValue(supplied, borrowed)
      if (usdValue !== undefined) position.usdValue = usdValue
      result.push(position)
    }

    for (const stake of stakes) {
      const vaultAddress = keyToBase58(stake.decoded.vault)
      const vault = vaults.get(vaultAddress)
      if (!vault) continue

      const lpAmount = toBigInt(stake.decoded.amount)
      if (lpAmount <= 0n) continue

      const principalMint = vault.principalMint
      if (isDefaultKey(principalMint)) continue

      const { amount: principalAmount, source: valuationSource } =
        computeVaultPrincipalAmount(
          lpAmount,
          vault,
          vaultTotalNav.get(vaultAddress),
        )
      if (principalAmount <= 0n) continue

      const suppliedAsset = buildSuppliedAsset(
        principalMint,
        principalAmount,
        mintDecimals(principalMint, tokens, mintDecimalsMap),
        tokens,
      )

      const position: LendingDefiPosition = {
        platformId: 'loopscale',
        positionKind: 'lending',
        supplied: [suppliedAsset],
        ...(suppliedAsset.usdValue !== undefined && {
          usdValue: suppliedAsset.usdValue,
        }),
        meta: {
          loopscale: {
            source: 'vault-stake',
            account: stake.address,
            vault: vaultAddress,
            lpMint: vault.lpMint,
            lpAmount: lpAmount.toString(),
            valuationSource,
          },
        },
      }

      result.push(position)
    }

    const stakeKeys = new Set(
      stakes.map((stake) => {
        const vaultAddress = keyToBase58(stake.decoded.vault)
        const lpAmount = toBigInt(stake.decoded.amount)
        return `${vaultAddress}:${lpAmount.toString()}`
      }),
    )

    for (const info of rewardsInfo) {
      const vaultAddress = keyToBase58(info.decoded.vault_address)
      const vault = vaults.get(vaultAddress)
      if (!vault) continue

      const lpAmount = toBigInt(info.decoded.lp_amount)
      if (lpAmount <= 0n) continue
      if (stakeKeys.has(`${vaultAddress}:${lpAmount.toString()}`)) continue

      const principalMint = vault.principalMint
      if (isDefaultKey(principalMint)) continue

      const { amount: principalAmount, source: valuationSource } =
        computeVaultPrincipalAmount(
          lpAmount,
          vault,
          vaultTotalNav.get(vaultAddress),
        )
      if (principalAmount <= 0n) continue

      const suppliedAsset = buildSuppliedAsset(
        principalMint,
        principalAmount,
        mintDecimals(principalMint, tokens, mintDecimalsMap),
        tokens,
      )

      const position: LendingDefiPosition = {
        platformId: 'loopscale',
        positionKind: 'lending',
        supplied: [suppliedAsset],
        ...(suppliedAsset.usdValue !== undefined && {
          usdValue: suppliedAsset.usdValue,
        }),
        meta: {
          loopscale: {
            source: 'vault-deposit',
            account: info.address,
            vault: vaultAddress,
            lpMint: vault.lpMint,
            lpAmount: lpAmount.toString(),
            valuationSource,
          },
        },
      }

      result.push(position)
    }

    for (const strategy of strategies) {
      const principalMint = keyToBase58(strategy.decoded.principal_mint)
      if (isDefaultKey(principalMint)) continue

      const netAssetValue = computeStrategyNav(strategy)
      if (netAssetValue <= 0n) continue

      const suppliedAsset = buildSuppliedAsset(
        principalMint,
        netAssetValue,
        mintDecimals(principalMint, tokens, mintDecimalsMap),
        tokens,
      )
      const position: LendingDefiPosition = {
        platformId: 'loopscale',
        positionKind: 'lending',
        supplied: [suppliedAsset],
        ...(suppliedAsset.usdValue !== undefined && {
          usdValue: suppliedAsset.usdValue,
        }),
        meta: {
          loopscale: {
            source: 'strategy',
            account: strategy.address,
            lender: keyToBase58(strategy.decoded.lender),
            market: keyToBase58(strategy.decoded.market_information),
          },
        },
      }

      result.push(position)
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)
    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
      discriminator: LOAN_DISCRIMINATOR,
      ownerOffset: LOAN_BORROWER_OFFSET,
    },
    {
      programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
      discriminator: VAULT_STAKE_DISCRIMINATOR,
      ownerOffset: VAULT_STAKE_USER_OFFSET,
    },
    {
      programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
      discriminator: STRATEGY_DISCRIMINATOR,
      ownerOffset: STRATEGY_LENDER_OFFSET,
    },
    {
      programId: LOOPSCALE_IDL_SOURCE_PROGRAM_ID,
      discriminator: USER_REWARDS_INFO_DISCRIMINATOR,
      ownerOffset: USER_REWARDS_INFO_USER_OFFSET,
    },
  ],
}

export default loopscaleIntegration
