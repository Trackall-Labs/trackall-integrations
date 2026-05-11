import { BorshCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  SolanaIntegration,
  SolanaPlugins,
  StakedAsset,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import bondsIdl from './idls/bonds.json'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const BONDS_PROGRAM_ID = '4tdmkuY6EStxbS6Y8s5ueznL3VPMSugrvQuDeAHGZhSt'
const BONDS_PROGRAM_V2_ID = 'BanxxEcFZPJLKhS59EkwTa8SZez8vDYTiJVN78mGHWDi'
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BANX_TOKEN_MINT = 'BANXbTpN8U2cU41FjPxe2Ti37PiT5cCxLUKDQZuJeMMR'
const BANX_SOL_MINT = 'BANXyWgPpa519e2MtQF1ecRbKYKKDMXPF1dyBxUq9NQG'

const BOND_TRADE_TRANSACTION_DISCRIMINATOR_B58 = 'b6hwxHZor7i'
const BOND_OFFER_DISCRIMINATOR_B58 = 'A6YWkLyWjLB'
const USER_VAULT_DISCRIMINATOR_B58 = '4u2LxSnUbZf'
const USER_VAULT_V2_DISCRIMINATOR_B58 = 'KiMThkZcrc8'
const BANX_TOKEN_STAKE_PREFIX = 'banx_token_stake'

const BTT_USER_OFFSET = 41
const BTT_SELLER_OFFSET = 147
const BOND_OFFER_ASSET_RECEIVER_OFFSET = 130
const USER_VAULT_USER_OFFSET = 9
const USER_VAULT_V2_USER_OFFSET = 41
const USER_VAULT_V2_VAULT_OFFSET = 9
const USER_VAULT_V2_STATE_OFFSET = 8
const USER_VAULT_V2_LIQUIDITY_OFFSET = 73
const VAULT_V2_MINT_OFFSET = 49

const ACTIVE_LOAN_STATES = new Set([
  'perpetualActive',
  'perpetualManualTerminating',
  'perpetualPartialRepaid',
  'perpetualRefinancedActive',
  'perpetualBorrowerListing',
  'perpetualLenderListing',
  'perpetualSellingLoan',
  'perpetualSellingListing',
  'perpetualAutoTerminating',
])

const OPEN_OFFER_STATES = new Set([
  'perpetualOnMarket',
  'perpetualBondingCurveOnMarket',
  'perpetualListing',
])

export const PROGRAM_IDS = [BONDS_PROGRAM_ID, BONDS_PROGRAM_V2_ID] as const

const bondsCoder = new BorshCoder(bondsIdl as never)
const BOND_TRADE_TRANSACTION_DISCRIMINATOR =
  bondsCoder.accounts.accountDiscriminator('bondTradeTransactionV3')
const BOND_OFFER_DISCRIMINATOR =
  bondsCoder.accounts.accountDiscriminator('bondOfferV3')
const USER_VAULT_DISCRIMINATOR =
  bondsCoder.accounts.accountDiscriminator('userVault')
const USER_VAULT_V2_DISCRIMINATOR = Uint8Array.from([
  111, 224, 169, 186, 223, 215, 84, 49,
])

type LendingTokenType = 'nativeSol' | 'usdc' | 'banxSol'

interface BondTradeTransactionV3Raw {
  bondTradeTransactionState: unknown
  bondOffer: unknown
  user: unknown
  seller: unknown
  fbondTokenMint: unknown
  lendingToken: unknown
  currentRemainingLent: unknown
  lenderOriginalLent: unknown
  borrowerOriginalLent: unknown
  collateralAmountSnapshot: unknown
  soldAt: unknown
  redeemedAt: unknown
}

interface BondOfferV3Raw {
  pairState: unknown
  assetReceiver: unknown
  fundsSolOrTokenBalance: unknown
  buyOrdersQuantity: unknown
  bondingCurve: {
    bondingType: unknown
  }
}

interface FraktBondRaw {
  fraktBondState: unknown
  banxStake: unknown
  fbondTokenMint: unknown
  fbondIssuer: unknown
}

interface UserVaultRaw {
  userVaultState: unknown
  user: unknown
  lendingTokenType: unknown
  offerLiquidityAmount: unknown
  liquidityInLoansAmount: unknown
  repaymentsAmount: unknown
  interestRewardsAmount: unknown
}

interface BanxTokenStakeRaw {
  banxStakeState: unknown
  user: unknown
  tokensStaked: unknown
  stakedAt: unknown
  unstakedAt: unknown
}

interface BanxStakeAccountRaw {
  banxStakeState: unknown
  nftMint: unknown
  isLoaned: unknown
  playerPoints: unknown
}

interface FraktBondSource {
  state: string
  issuer: string
  collateralTokenMint: string | null
  banxStake: string | null
}

interface LoanBanxStakeSource {
  address: string
  state: string
  nftMint: string | null
  isLoaned: boolean
  playerPoints: bigint
}

interface ActiveLoan {
  address: string
  state: string
  user: string
  seller: string
  bondOffer: string
  fraktBond: string
  lendingTokenType: LendingTokenType
  currentRemainingLent: bigint
  lenderOriginalLent: bigint
  borrowerOriginalLent: bigint
  collateralAmountSnapshot: bigint
  soldAt: bigint
  redeemedAt: bigint
}

interface OfferPositionSource {
  address: string
  pairState: string
  assetReceiver: string
  lendingTokenType: LendingTokenType
  fundsBalance: bigint
  buyOrdersQuantity: bigint
}

interface UserVaultPositionSource {
  address: string
  state: string
  user: string
  lendingTokenType: LendingTokenType
  offerLiquidityAmount: bigint
  liquidityInLoansAmount: bigint
  repaymentsAmount: bigint
  interestRewardsAmount: bigint
}

interface UserVaultV2PositionSource {
  address: string
  state: number
  user: string
  vault: string
  liquidityAmount: bigint
}

function decodeAccount<T>(name: string, data: Uint8Array): T | null {
  try {
    return bondsCoder.accounts.decode(name, Buffer.from(data)) as T
  } catch {
    return null
  }
}

function enumName(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value as Record<string, unknown>)
  return keys.length === 1 ? (keys[0] ?? null) : null
}

function toAddress(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof PublicKey) return value.toBase58()
  if (
    value &&
    typeof value === 'object' &&
    'toBase58' in value &&
    typeof (value as { toBase58?: unknown }).toBase58 === 'function'
  ) {
    return (value as { toBase58: () => string }).toBase58()
  }
  return null
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.length > 0) return BigInt(value)
  if (
    value &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof (value as { toString?: unknown }).toString === 'function'
  ) {
    return BigInt((value as { toString: () => string }).toString())
  }
  return 0n
}

function readU128LE(data: Uint8Array, offset: number): bigint | null {
  if (offset < 0 || offset + 16 > data.length) return null
  const view = data instanceof Buffer ? data : Buffer.from(data)
  const lo = view.readBigUInt64LE(offset)
  const hi = view.readBigUInt64LE(offset + 8)
  return (hi << 64n) + lo
}

function toLendingTokenType(value: unknown): LendingTokenType | null {
  const name = enumName(value)
  if (name === 'nativeSol' || name === 'usdc' || name === 'banxSol') return name
  return null
}

function bondingCurveTypeToLendingTokenType(
  value: unknown,
): LendingTokenType | null {
  const name = enumName(value)
  if (name === 'linear' || name === 'exponential') return 'nativeSol'
  if (name === 'linearUsdc' || name === 'exponentialUsdc') return 'usdc'
  if (name === 'linearBanxSol' || name === 'exponentialBanxSol')
    return 'banxSol'
  return null
}

function lendingTokenTypeToMint(lendingTokenType: LendingTokenType): string {
  if (lendingTokenType === 'usdc') return USDC_MINT
  if (lendingTokenType === 'banxSol') return BANX_SOL_MINT
  return WRAPPED_SOL_MINT
}

function lendingTokenTypeToDecimals(
  lendingTokenType: LendingTokenType,
): number {
  if (lendingTokenType === 'usdc') return 6
  return 9
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

function buildAmountValue(
  tokenMint: string,
  amountRaw: bigint,
  fallbackDecimals: number,
  tokens: SolanaPlugins['tokens'],
): {
  amount: {
    token: string
    amount: string
    decimals: string
  }
  priceUsd?: string
  usdValue?: string
} | null {
  if (amountRaw <= 0n) return null
  const token = tokens.get(tokenMint)
  const decimals = token?.decimals ?? fallbackDecimals
  const usdValue = buildUsdValue(amountRaw, decimals, token?.priceUsd)

  return {
    amount: {
      token: tokenMint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function buildSuppliedAsset(
  lendingTokenType: LendingTokenType,
  amountRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): LendingSuppliedAsset | null {
  const tokenMint = lendingTokenTypeToMint(lendingTokenType)
  const value = buildAmountValue(
    tokenMint,
    amountRaw,
    lendingTokenTypeToDecimals(lendingTokenType),
    tokens,
  )
  return value
}

function buildBorrowedAsset(
  lendingTokenType: LendingTokenType,
  amountRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): LendingBorrowedAsset | null {
  const tokenMint = lendingTokenTypeToMint(lendingTokenType)
  const value = buildAmountValue(
    tokenMint,
    amountRaw,
    lendingTokenTypeToDecimals(lendingTokenType),
    tokens,
  )
  return value
}

function buildSuppliedAssetByMint(
  tokenMint: string,
  amountRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): LendingSuppliedAsset | null {
  const fallbackDecimals = tokenMint === USDC_MINT ? 6 : 9
  const value = buildAmountValue(tokenMint, amountRaw, fallbackDecimals, tokens)
  return value
}

function buildBorrowedAssetByMint(
  tokenMint: string,
  amountRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): LendingBorrowedAsset | null {
  const fallbackDecimals = tokenMint === USDC_MINT ? 6 : 9
  const value = buildAmountValue(tokenMint, amountRaw, fallbackDecimals, tokens)
  return value
}

function buildStakedAsset(
  tokenMint: string,
  amountRaw: bigint,
  tokens: SolanaPlugins['tokens'],
): StakedAsset | null {
  const value = buildAmountValue(tokenMint, amountRaw, 9, tokens)
  return value
}

function isLoanStateActive(state: string): boolean {
  return ACTIVE_LOAN_STATES.has(state)
}

function isOfferStateOpen(state: string): boolean {
  return OPEN_OFFER_STATES.has(state)
}

function sumPositionUsdValue(
  supplied: LendingSuppliedAsset[] | undefined,
  borrowed: LendingBorrowedAsset[] | undefined,
): string | undefined {
  const values = [...(supplied ?? []), ...(borrowed ?? [])]
    .map((entry) => entry.usdValue)
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter((value) => Number.isFinite(value))

  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0).toString()
}

export const banxIntegration: SolanaIntegration = {
  platformId: 'banx',

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

    const initialProgramAccounts = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: BONDS_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: BOND_TRADE_TRANSACTION_DISCRIMINATOR_B58,
            },
          },
          { memcmp: { offset: BTT_USER_OFFSET, bytes: address } },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: BONDS_PROGRAM_ID,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: BOND_TRADE_TRANSACTION_DISCRIMINATOR_B58,
            },
          },
          { memcmp: { offset: BTT_SELLER_OFFSET, bytes: address } },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: BONDS_PROGRAM_ID,
        filters: [
          { memcmp: { offset: 0, bytes: BOND_OFFER_DISCRIMINATOR_B58 } },
          {
            memcmp: {
              offset: BOND_OFFER_ASSET_RECEIVER_OFFSET,
              bytes: address,
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: BONDS_PROGRAM_ID,
        filters: [
          { memcmp: { offset: 0, bytes: USER_VAULT_DISCRIMINATOR_B58 } },
          { memcmp: { offset: USER_VAULT_USER_OFFSET, bytes: address } },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: BONDS_PROGRAM_V2_ID,
        filters: [
          { memcmp: { offset: 0, bytes: USER_VAULT_V2_DISCRIMINATOR_B58 } },
          { memcmp: { offset: USER_VAULT_V2_USER_OFFSET, bytes: address } },
        ],
      },
    ]

    const loanAccountsMap = initialProgramAccounts
    const offersMap = initialProgramAccounts
    const userVaultsMap = initialProgramAccounts
    const userVaultsV2Map = Object.fromEntries(
      Object.entries(initialProgramAccounts).filter(
        ([, account]) =>
          account.exists && account.programAddress === BONDS_PROGRAM_V2_ID,
      ),
    )

    const activeLoans = new Map<string, ActiveLoan>()
    for (const account of Object.values(loanAccountsMap)) {
      if (!account.exists || activeLoans.has(account.address)) continue
      const decoded = decodeAccount<BondTradeTransactionV3Raw>(
        'bondTradeTransactionV3',
        account.data,
      )
      if (!decoded) continue

      const state = enumName(decoded.bondTradeTransactionState)
      const user = toAddress(decoded.user)
      const seller = toAddress(decoded.seller)
      const bondOffer = toAddress(decoded.bondOffer)
      const fraktBond = toAddress(decoded.fbondTokenMint)
      const lendingTokenType = toLendingTokenType(decoded.lendingToken)

      if (!state || !isLoanStateActive(state)) continue
      if (!user || !seller || !bondOffer || !fraktBond || !lendingTokenType)
        continue
      if (user !== address && seller !== address) continue

      activeLoans.set(account.address, {
        address: account.address,
        state,
        user,
        seller,
        bondOffer,
        fraktBond,
        lendingTokenType,
        currentRemainingLent: toBigInt(decoded.currentRemainingLent),
        lenderOriginalLent: toBigInt(decoded.lenderOriginalLent),
        borrowerOriginalLent: toBigInt(decoded.borrowerOriginalLent),
        collateralAmountSnapshot: toBigInt(decoded.collateralAmountSnapshot),
        soldAt: toBigInt(decoded.soldAt),
        redeemedAt: toBigInt(decoded.redeemedAt),
      })
    }

    const userVaultsV2: UserVaultV2PositionSource[] = []
    const vaultV2Addresses: string[] = []
    for (const account of Object.values(userVaultsV2Map)) {
      if (!account.exists) continue
      const data = Buffer.from(account.data)
      if (data.length < USER_VAULT_V2_LIQUIDITY_OFFSET + 16) continue

      const state = data[USER_VAULT_V2_STATE_OFFSET] ?? 0
      const userBytes = data.subarray(
        USER_VAULT_V2_USER_OFFSET,
        USER_VAULT_V2_USER_OFFSET + 32,
      )
      const vaultBytes = data.subarray(
        USER_VAULT_V2_VAULT_OFFSET,
        USER_VAULT_V2_VAULT_OFFSET + 32,
      )
      const user = new PublicKey(userBytes).toBase58()
      if (user !== address) continue

      const vault = new PublicKey(vaultBytes).toBase58()
      const liquidityAmount =
        readU128LE(data, USER_VAULT_V2_LIQUIDITY_OFFSET) ?? 0n
      userVaultsV2.push({
        address: account.address,
        state,
        user,
        vault,
        liquidityAmount,
      })
      vaultV2Addresses.push(vault)
    }

    const relatedAddresses = [
      ...new Set(
        [...activeLoans.values()].flatMap((loan) => [
          loan.bondOffer,
          loan.fraktBond,
        ]),
      ),
    ]
    const relatedAddressSet = new Set(relatedAddresses)
    const vaultV2AddressSet = new Set(vaultV2Addresses)

    const userPubkey = new PublicKey(address)
    const banxTokenStakeAddress = PublicKey.findProgramAddressSync(
      [Buffer.from(BANX_TOKEN_STAKE_PREFIX), userPubkey.toBuffer()],
      new PublicKey(BONDS_PROGRAM_ID),
    )[0].toBase58()

    const round2Addresses = [
      ...new Set([
        banxTokenStakeAddress,
        ...relatedAddresses,
        ...vaultV2Addresses,
      ]),
    ]
    const round2Accounts =
      round2Addresses.length > 0 ? yield round2Addresses : {}

    const relatedAccounts = Object.fromEntries(
      Object.entries(round2Accounts).filter(([accountAddress]) =>
        relatedAddressSet.has(accountAddress),
      ),
    )
    const vaultV2Accounts = Object.fromEntries(
      Object.entries(round2Accounts).filter(([accountAddress]) =>
        vaultV2AddressSet.has(accountAddress),
      ),
    )
    const banxTokenStakeMap =
      round2Accounts[banxTokenStakeAddress] !== undefined
        ? { [banxTokenStakeAddress]: round2Accounts[banxTokenStakeAddress] }
        : {}

    const relatedOffers = new Map<string, OfferPositionSource>()
    const relatedFraktBonds = new Map<string, FraktBondSource>()

    for (const account of Object.values(relatedAccounts)) {
      if (!account.exists) continue

      const offerDecoded = decodeAccount<BondOfferV3Raw>(
        'bondOfferV3',
        account.data,
      )
      if (offerDecoded) {
        const pairState = enumName(offerDecoded.pairState)
        const assetReceiver = toAddress(offerDecoded.assetReceiver)
        const lendingTokenType = bondingCurveTypeToLendingTokenType(
          offerDecoded.bondingCurve?.bondingType,
        )
        if (pairState && assetReceiver && lendingTokenType) {
          relatedOffers.set(account.address, {
            address: account.address,
            pairState,
            assetReceiver,
            lendingTokenType,
            fundsBalance: toBigInt(offerDecoded.fundsSolOrTokenBalance),
            buyOrdersQuantity: toBigInt(offerDecoded.buyOrdersQuantity),
          })
        }
      }

      const fraktDecoded = decodeAccount<FraktBondRaw>(
        'fraktBond',
        account.data,
      )
      if (fraktDecoded) {
        const state = enumName(fraktDecoded.fraktBondState)
        const issuer = toAddress(fraktDecoded.fbondIssuer)
        const collateralTokenMint = toAddress(fraktDecoded.fbondTokenMint)
        const banxStake = toAddress(fraktDecoded.banxStake)
        if (state && issuer) {
          relatedFraktBonds.set(account.address, {
            state,
            issuer,
            collateralTokenMint,
            banxStake,
          })
        }
      }
    }

    const banxStakeAddresses = [
      ...new Set(
        [...activeLoans.values()].flatMap((loan) => {
          if (loan.user !== address) return []
          const fraktBond = relatedFraktBonds.get(loan.fraktBond)
          if (!fraktBond) return []

          const hasSnapshotCollateral =
            fraktBond.collateralTokenMint !== null &&
            loan.collateralAmountSnapshot > 0n
          if (hasSnapshotCollateral) return []

          return fraktBond.banxStake &&
            fraktBond.banxStake !== '11111111111111111111111111111111'
            ? [fraktBond.banxStake]
            : []
        }),
      ),
    ]
    const banxStakeAccounts =
      banxStakeAddresses.length > 0 ? yield banxStakeAddresses : {}

    const loanBanxStakes = new Map<string, LoanBanxStakeSource>()
    for (const account of Object.values(banxStakeAccounts)) {
      if (!account.exists) continue

      const decoded = decodeAccount<BanxStakeAccountRaw>(
        'banxStake',
        account.data,
      )
      if (!decoded) continue

      const state = enumName(decoded.banxStakeState)
      if (!state) continue

      const isLoaned = Boolean(decoded.isLoaned)
      const playerPoints = toBigInt(decoded.playerPoints)
      loanBanxStakes.set(account.address, {
        address: account.address,
        state,
        nftMint: toAddress(decoded.nftMint),
        isLoaned,
        playerPoints,
      })
    }

    const ownerOffers: OfferPositionSource[] = []
    for (const account of Object.values(offersMap)) {
      if (!account.exists) continue
      const decoded = decodeAccount<BondOfferV3Raw>('bondOfferV3', account.data)
      if (!decoded) continue

      const pairState = enumName(decoded.pairState)
      const assetReceiver = toAddress(decoded.assetReceiver)
      const lendingTokenType = bondingCurveTypeToLendingTokenType(
        decoded.bondingCurve?.bondingType,
      )
      if (!pairState || !assetReceiver || !lendingTokenType) continue
      if (assetReceiver !== address) continue

      ownerOffers.push({
        address: account.address,
        pairState,
        assetReceiver,
        lendingTokenType,
        fundsBalance: toBigInt(decoded.fundsSolOrTokenBalance),
        buyOrdersQuantity: toBigInt(decoded.buyOrdersQuantity),
      })
    }

    const userVaults = new Map<LendingTokenType, UserVaultPositionSource>()
    for (const account of Object.values(userVaultsMap)) {
      if (!account.exists) continue
      const decoded = decodeAccount<UserVaultRaw>('userVault', account.data)
      if (!decoded) continue
      const state = enumName(decoded.userVaultState)
      const user = toAddress(decoded.user)
      const lendingTokenType = toLendingTokenType(decoded.lendingTokenType)
      if (!state || !user || !lendingTokenType) continue
      if (user !== address) continue

      userVaults.set(lendingTokenType, {
        address: account.address,
        state,
        user,
        lendingTokenType,
        offerLiquidityAmount: toBigInt(decoded.offerLiquidityAmount),
        liquidityInLoansAmount: toBigInt(decoded.liquidityInLoansAmount),
        repaymentsAmount: toBigInt(decoded.repaymentsAmount),
        interestRewardsAmount: toBigInt(decoded.interestRewardsAmount),
      })
    }

    const banxTokenStakes: Array<{
      address: string
      state: string
      tokensStaked: bigint
      stakedAt: bigint
      unstakedAt: bigint
    }> = []
    for (const account of Object.values(banxTokenStakeMap)) {
      if (!account.exists) continue
      const decoded = decodeAccount<BanxTokenStakeRaw>(
        'banxTokenStake',
        account.data,
      )
      if (!decoded) continue

      const state = enumName(decoded.banxStakeState)
      const user = toAddress(decoded.user)
      if (!state || !user || user !== address) continue

      const tokensStaked = toBigInt(decoded.tokensStaked)
      if (tokensStaked <= 0n) continue

      banxTokenStakes.push({
        address: account.address,
        state,
        tokensStaked,
        stakedAt: toBigInt(decoded.stakedAt),
        unstakedAt: toBigInt(decoded.unstakedAt),
      })
    }

    const vaultV2MintByAddress = new Map<string, string>()
    for (const account of Object.values(vaultV2Accounts)) {
      if (!account.exists) continue
      const data = Buffer.from(account.data)
      if (data.length < VAULT_V2_MINT_OFFSET + 32) continue
      const mint = new PublicKey(
        data.subarray(VAULT_V2_MINT_OFFSET, VAULT_V2_MINT_OFFSET + 32),
      ).toBase58()
      vaultV2MintByAddress.set(account.address, mint)
    }

    const positions: UserDefiPosition[] = []
    const seenPositionKeys = new Set<string>()

    for (const loan of activeLoans.values()) {
      const fraktBond = relatedFraktBonds.get(loan.fraktBond)
      const bondOffer = relatedOffers.get(loan.bondOffer)
      const vault = userVaults.get(loan.lendingTokenType)

      if (loan.user === address) {
        const key = `loan:${loan.address}:lender`
        if (!seenPositionKeys.has(key)) {
          const debtAmount =
            loan.currentRemainingLent || loan.lenderOriginalLent
          const supplied = buildSuppliedAsset(
            loan.lendingTokenType,
            debtAmount,
            tokens,
          )
          const collateralFromSnapshot =
            fraktBond?.collateralTokenMint && loan.collateralAmountSnapshot > 0n
              ? buildBorrowedAssetByMint(
                  fraktBond.collateralTokenMint,
                  loan.collateralAmountSnapshot,
                  tokens,
                )
              : null
          const linkedBanxStake = fraktBond?.banxStake
            ? loanBanxStakes.get(fraktBond.banxStake)
            : null
          const collateralFromBanxStake =
            !collateralFromSnapshot &&
            linkedBanxStake &&
            linkedBanxStake.isLoaned &&
            linkedBanxStake.playerPoints > 0n
              ? buildBorrowedAssetByMint(
                  BANX_TOKEN_MINT,
                  linkedBanxStake.playerPoints * 10n ** 9n,
                  tokens,
                )
              : null
          const collateral = collateralFromSnapshot ?? collateralFromBanxStake
          if (supplied || collateral) {
            const position: LendingDefiPosition = {
              platformId: 'banx',
              positionKind: 'lending',
              ...(supplied && { supplied: [supplied] }),
              ...(collateral && { borrowed: [collateral] }),
              meta: {
                banx: {
                  role: 'lender',
                  state: loan.state,
                  loan: loan.address,
                  bondOffer: loan.bondOffer,
                  fraktBond: loan.fraktBond,
                  soldAt: loan.soldAt.toString(),
                  redeemedAt: loan.redeemedAt.toString(),
                  ...(bondOffer && {
                    offerState: bondOffer.pairState,
                  }),
                  ...(fraktBond && {
                    fraktBondState: fraktBond.state,
                    borrower: fraktBond.issuer,
                    collateralTokenMint: fraktBond.collateralTokenMint,
                    collateralAmountSnapshot:
                      loan.collateralAmountSnapshot.toString(),
                    banxStake: fraktBond.banxStake,
                  }),
                  ...(linkedBanxStake && {
                    banxStakeState: linkedBanxStake.state,
                    banxStakeIsLoaned: linkedBanxStake.isLoaned,
                    banxStakePlayerPoints:
                      linkedBanxStake.playerPoints.toString(),
                  }),
                  ...(vault && {
                    vault: vault.address,
                    vaultState: vault.state,
                    vaultOfferLiquidityAmount:
                      vault.offerLiquidityAmount.toString(),
                    vaultLiquidityInLoansAmount:
                      vault.liquidityInLoansAmount.toString(),
                  }),
                },
              },
            }
            const usdValue = sumPositionUsdValue(
              position.supplied,
              position.borrowed,
            )
            if (usdValue !== undefined) position.usdValue = usdValue
            positions.push(position)
            seenPositionKeys.add(key)
          }
        }
      }

      if (loan.seller === address) {
        const key = `loan:${loan.address}:borrower`
        if (!seenPositionKeys.has(key)) {
          const amount = loan.currentRemainingLent || loan.borrowerOriginalLent
          const borrowed = buildBorrowedAsset(
            loan.lendingTokenType,
            amount,
            tokens,
          )
          const collateral =
            fraktBond?.collateralTokenMint && loan.collateralAmountSnapshot > 0n
              ? buildSuppliedAssetByMint(
                  fraktBond.collateralTokenMint,
                  loan.collateralAmountSnapshot,
                  tokens,
                )
              : null
          if (borrowed || collateral) {
            const position: LendingDefiPosition = {
              platformId: 'banx',
              positionKind: 'lending',
              ...(collateral && { supplied: [collateral] }),
              ...(borrowed && { borrowed: [borrowed] }),
              meta: {
                banx: {
                  role: 'borrower',
                  state: loan.state,
                  loan: loan.address,
                  bondOffer: loan.bondOffer,
                  fraktBond: loan.fraktBond,
                  soldAt: loan.soldAt.toString(),
                  redeemedAt: loan.redeemedAt.toString(),
                  ...(bondOffer && {
                    offerState: bondOffer.pairState,
                    lender: bondOffer.assetReceiver,
                  }),
                  ...(fraktBond && {
                    fraktBondState: fraktBond.state,
                    borrower: fraktBond.issuer,
                    collateralTokenMint: fraktBond.collateralTokenMint,
                    collateralAmountSnapshot:
                      loan.collateralAmountSnapshot.toString(),
                  }),
                },
              },
            }
            const usdValue = sumPositionUsdValue(
              position.supplied,
              position.borrowed,
            )
            if (usdValue !== undefined) position.usdValue = usdValue
            positions.push(position)
            seenPositionKeys.add(key)
          }
        }
      }
    }

    for (const offer of ownerOffers) {
      if (!isOfferStateOpen(offer.pairState)) continue
      if (offer.fundsBalance <= 0n && offer.buyOrdersQuantity <= 0n) continue

      const key = `offer:${offer.address}`
      if (seenPositionKeys.has(key)) continue

      const supplied = buildSuppliedAsset(
        offer.lendingTokenType,
        offer.fundsBalance,
        tokens,
      )
      if (!supplied) continue

      const vault = userVaults.get(offer.lendingTokenType)
      const position: LendingDefiPosition = {
        platformId: 'banx',
        positionKind: 'lending',
        supplied: [supplied],
        meta: {
          banx: {
            role: 'offer',
            offer: offer.address,
            state: offer.pairState,
            buyOrdersQuantity: offer.buyOrdersQuantity.toString(),
            ...(vault && {
              vault: vault.address,
              vaultState: vault.state,
              vaultOfferLiquidityAmount: vault.offerLiquidityAmount.toString(),
              vaultLiquidityInLoansAmount:
                vault.liquidityInLoansAmount.toString(),
            }),
          },
        },
      }

      const usdValue = sumPositionUsdValue(position.supplied, position.borrowed)
      if (usdValue !== undefined) position.usdValue = usdValue
      positions.push(position)
      seenPositionKeys.add(key)
    }

    for (const vault of userVaults.values()) {
      if (vault.state !== 'active') continue
      if (vault.offerLiquidityAmount <= 0n) continue

      const key = `vault:${vault.address}`
      if (seenPositionKeys.has(key)) continue

      const supplied = buildSuppliedAsset(
        vault.lendingTokenType,
        vault.offerLiquidityAmount,
        tokens,
      )
      if (!supplied) continue

      const position: LendingDefiPosition = {
        platformId: 'banx',
        positionKind: 'lending',
        supplied: [supplied],
        meta: {
          banx: {
            role: 'vault',
            vault: vault.address,
            state: vault.state,
            vaultOfferLiquidityAmount: vault.offerLiquidityAmount.toString(),
            vaultLiquidityInLoansAmount:
              vault.liquidityInLoansAmount.toString(),
            vaultRepaymentsAmount: vault.repaymentsAmount.toString(),
            vaultInterestRewardsAmount: vault.interestRewardsAmount.toString(),
          },
        },
      }

      const usdValue = sumPositionUsdValue(position.supplied, position.borrowed)
      if (usdValue !== undefined) position.usdValue = usdValue
      positions.push(position)
      seenPositionKeys.add(key)
    }

    for (const vault of userVaultsV2) {
      if (vault.state === 0) continue
      if (vault.liquidityAmount <= 0n) continue

      const key = `vault-v2:${vault.address}`
      if (seenPositionKeys.has(key)) continue

      const mint = vaultV2MintByAddress.get(vault.vault) ?? USDC_MINT
      const supplied = buildSuppliedAssetByMint(
        mint,
        vault.liquidityAmount,
        tokens,
      )
      if (!supplied) continue

      const position: LendingDefiPosition = {
        platformId: 'banx',
        positionKind: 'lending',
        supplied: [supplied],
        meta: {
          banx: {
            role: 'vault',
            vault: vault.vault,
            vaultAccount: vault.address,
            vaultProgram: BONDS_PROGRAM_V2_ID,
            vaultStateCode: vault.state.toString(),
            vaultUserLiquidityAmount: vault.liquidityAmount.toString(),
            vaultMint: mint,
          },
        },
      }
      const usdValue = sumPositionUsdValue(position.supplied, position.borrowed)
      if (usdValue !== undefined) position.usdValue = usdValue
      positions.push(position)
      seenPositionKeys.add(key)
    }

    for (const stake of banxTokenStakes) {
      if (stake.state !== 'staked') continue

      const key = `stake:${stake.address}`
      if (seenPositionKeys.has(key)) continue

      const staked = buildStakedAsset(
        BANX_TOKEN_MINT,
        stake.tokensStaked,
        tokens,
      )
      if (!staked) continue

      const position: StakingDefiPosition = {
        platformId: 'banx',
        positionKind: 'staking',
        staked: [staked],
        meta: {
          banx: {
            role: 'stake',
            stake: stake.address,
            state: stake.state,
            stakedAt: stake.stakedAt.toString(),
            unstakedAt: stake.unstakedAt.toString(),
          },
        },
      }
      if (staked.usdValue !== undefined) {
        position.usdValue = staked.usdValue
      }

      positions.push(position)
      seenPositionKeys.add(key)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: BONDS_PROGRAM_ID,
      discriminator: BOND_TRADE_TRANSACTION_DISCRIMINATOR,
      ownerOffset: BTT_USER_OFFSET,
    },
    {
      programId: BONDS_PROGRAM_ID,
      discriminator: BOND_TRADE_TRANSACTION_DISCRIMINATOR,
      ownerOffset: BTT_SELLER_OFFSET,
    },
    {
      programId: BONDS_PROGRAM_ID,
      discriminator: BOND_OFFER_DISCRIMINATOR,
      ownerOffset: BOND_OFFER_ASSET_RECEIVER_OFFSET,
    },
    {
      programId: BONDS_PROGRAM_ID,
      discriminator: USER_VAULT_DISCRIMINATOR,
      ownerOffset: USER_VAULT_USER_OFFSET,
    },
    {
      programId: BONDS_PROGRAM_V2_ID,
      discriminator: USER_VAULT_V2_DISCRIMINATOR,
      ownerOffset: USER_VAULT_V2_USER_OFFSET,
    },
  ],
}

export default banxIntegration
