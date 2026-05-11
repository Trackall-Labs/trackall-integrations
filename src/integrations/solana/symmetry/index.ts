import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type {
  ConstantProductLiquidityDefiPosition,
  MaybeSolanaAccount,
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilter,
  UsersFilterPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'

const SYMMETRY_VAULTS_V3_PROGRAM_ID =
  'BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate'
const SYMMETRY_LEGACY_FUNDS_PROGRAM_ID =
  '2KehYt3KsEQR53jYcxjbQp2d2kCp4AkuQW68atufRwSr'

const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

const MINT_ACCOUNT_DECIMALS_OFFSET = 44

const VAULT_DISCRIMINATOR_BYTES = 8
const VAULT_VERSION_OFFSET = 0
const VAULT_MINT_OFFSET = 33
const VAULT_SUPPLY_OUTSTANDING_OFFSET = 65
const VAULT_NUM_TOKENS_OFFSET = 1750
const VAULT_COMPOSITION_OFFSET = 1751
const VAULT_MAX_TOKENS = 100

const ASSET_STRIDE = 289
const ASSET_MINT_OFFSET = 0
const ASSET_AMOUNT_OFFSET = 32
const ASSET_WEIGHT_OFFSET = 40
const ASSET_ACTIVE_OFFSET = 42

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111'
const VAULT_PDA_SEED = Buffer.from('basket')
const HUNDRED_PERCENT_BPS = 10_000
const LEGACY_FUND_MINT_OFFSET = 48
const LEGACY_FUND_SUPPLY_RAW_OFFSET = 88
const LEGACY_FUND_NUM_TOKENS_OFFSET = 168
const LEGACY_FUND_TOKEN_IDS_OFFSET = 176
const LEGACY_FUND_TOKEN_ID_STRIDE = 8
const LEGACY_FUND_MAX_TOKENS = 20
const LEGACY_FUND_AMOUNTS_OFFSET =
  LEGACY_FUND_TOKEN_IDS_OFFSET +
  LEGACY_FUND_MAX_TOKENS * LEGACY_FUND_TOKEN_ID_STRIDE

const LEGACY_FUNDS = [
  {
    name: 'ySOL',
    mint: '3htQDAvEx53jyMJ2FVHeztM5BRjfmNuBqceXu1fJRqWx',
    // Legacy Symmetry LSD basket composition shown in app.
    composition: [
      {
        mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
        tokenId: 5,
        weightBps: 4500,
        decimals: 9,
      },
      {
        mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
        tokenId: 6,
        weightBps: 4500,
        decimals: 9,
      },
      {
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        tokenId: 0,
        weightBps: 1000,
        decimals: 6,
      },
    ],
  },
] as const

type DecodedVaultAsset = {
  mint: string
  amountRaw: bigint
  weightBps: number
}

type DecodedVault = {
  version: number
  mint: string
  supplyOutstandingRaw: bigint
  assets: DecodedVaultAsset[]
}

type DecodedLegacyFund = {
  supplyRaw: bigint
  amountByTokenId: Map<number, bigint>
}

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  SYMMETRY_VAULTS_V3_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
] as const

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.slice(offset, offset + 32)).toBase58()
}

function readU16(data: Uint8Array, offset: number): number | null {
  if (data.length < offset + 2) return null
  return Buffer.from(data).readUInt16LE(offset)
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readMintDecimals(
  account: MaybeSolanaAccount | undefined,
): number | null {
  if (!account?.exists) return null
  if (
    account.programAddress !== TOKEN_PROGRAM_ID.toBase58() &&
    account.programAddress !== TOKEN_2022_PROGRAM_ID.toBase58()
  ) {
    return null
  }

  if (account.data.length <= MINT_ACCOUNT_DECIMALS_OFFSET) return null
  return account.data[MINT_ACCOUNT_DECIMALS_OFFSET] ?? null
}

function decodeVault(accountData: Uint8Array): DecodedVault | null {
  if (accountData.length <= VAULT_DISCRIMINATOR_BYTES) return null

  const data = accountData.slice(VAULT_DISCRIMINATOR_BYTES)
  if (data.length < VAULT_COMPOSITION_OFFSET) return null

  const version = data[VAULT_VERSION_OFFSET] ?? 0
  const mint = readPubkey(data, VAULT_MINT_OFFSET)
  const supplyOutstandingRaw = readU64(data, VAULT_SUPPLY_OUTSTANDING_OFFSET)
  const numTokens = data[VAULT_NUM_TOKENS_OFFSET] ?? 0

  if (!mint || supplyOutstandingRaw === null) return null
  if (numTokens > VAULT_MAX_TOKENS) return null

  const requiredLength = VAULT_COMPOSITION_OFFSET + numTokens * ASSET_STRIDE
  if (data.length < requiredLength) return null

  const assets: DecodedVaultAsset[] = []
  for (let index = 0; index < numTokens; index++) {
    const base = VAULT_COMPOSITION_OFFSET + index * ASSET_STRIDE

    const active = data[base + ASSET_ACTIVE_OFFSET] ?? 0
    if (active !== 1) continue

    const assetMint = readPubkey(data, base + ASSET_MINT_OFFSET)
    const amountRaw = readU64(data, base + ASSET_AMOUNT_OFFSET)
    const weightBps = readU16(data, base + ASSET_WEIGHT_OFFSET)

    if (!assetMint || amountRaw === null || weightBps === null) continue
    if (assetMint === SYSTEM_PROGRAM_ADDRESS) continue
    if (amountRaw === 0n) continue

    assets.push({ mint: assetMint, amountRaw, weightBps })
  }

  return {
    version,
    mint,
    supplyOutstandingRaw,
    assets,
  }
}

function decodeLegacyFund(accountData: Uint8Array): DecodedLegacyFund | null {
  if (accountData.length < LEGACY_FUND_AMOUNTS_OFFSET) return null

  const fundMint = readPubkey(accountData, LEGACY_FUND_MINT_OFFSET)
  if (!fundMint) return null

  const supplyRaw = readU64(accountData, LEGACY_FUND_SUPPLY_RAW_OFFSET)
  const numTokens = readU64(accountData, LEGACY_FUND_NUM_TOKENS_OFFSET)
  if (supplyRaw === null || supplyRaw === 0n || numTokens === null) return null
  if (numTokens > BigInt(LEGACY_FUND_MAX_TOKENS)) return null

  const tokenCount = Number(numTokens)
  const required =
    LEGACY_FUND_AMOUNTS_OFFSET + tokenCount * LEGACY_FUND_TOKEN_ID_STRIDE
  if (accountData.length < required) return null

  const amountByTokenId = new Map<number, bigint>()
  for (let i = 0; i < tokenCount; i++) {
    const tokenIdRaw = readU64(
      accountData,
      LEGACY_FUND_TOKEN_IDS_OFFSET + i * LEGACY_FUND_TOKEN_ID_STRIDE,
    )
    const amountRaw = readU64(
      accountData,
      LEGACY_FUND_AMOUNTS_OFFSET + i * LEGACY_FUND_TOKEN_ID_STRIDE,
    )
    if (tokenIdRaw === null || amountRaw === null || amountRaw <= 0n) continue
    if (tokenIdRaw > BigInt(Number.MAX_SAFE_INTEGER)) continue
    amountByTokenId.set(Number(tokenIdRaw), amountRaw)
  }

  return { supplyRaw, amountByTokenId }
}

function selectBestLegacyFundDecoded(
  fundDefinition: (typeof LEGACY_FUNDS)[number],
  decodedCandidates: DecodedLegacyFund[],
): DecodedLegacyFund | undefined {
  let bestCandidate: DecodedLegacyFund | undefined
  let bestCoverage = -1
  let bestRequiredAmountSum = -1n
  let bestSupply = -1n
  let bestTotalAmountSum = -1n

  for (const candidate of decodedCandidates) {
    let coverage = 0
    let requiredAmountSum = 0n
    let totalAmountSum = 0n

    for (const amount of candidate.amountByTokenId.values()) {
      totalAmountSum += amount
    }

    for (const component of fundDefinition.composition) {
      const amount = candidate.amountByTokenId.get(component.tokenId) ?? 0n
      if (amount > 0n) {
        coverage++
        requiredAmountSum += amount
      }
    }

    const isBetter =
      coverage > bestCoverage ||
      (coverage === bestCoverage &&
        requiredAmountSum > bestRequiredAmountSum) ||
      (coverage === bestCoverage &&
        requiredAmountSum === bestRequiredAmountSum &&
        candidate.supplyRaw > bestSupply) ||
      (coverage === bestCoverage &&
        requiredAmountSum === bestRequiredAmountSum &&
        candidate.supplyRaw === bestSupply &&
        totalAmountSum > bestTotalAmountSum)

    if (isBetter) {
      bestCandidate = candidate
      bestCoverage = coverage
      bestRequiredAmountSum = requiredAmountSum
      bestSupply = candidate.supplyRaw
      bestTotalAmountSum = totalAmountSum
    }
  }

  return bestCandidate
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

function buildLegacyFundPoolTokens(
  fundDefinition: (typeof LEGACY_FUNDS)[number],
  fundAmountRaw: bigint,
  fundDecimals: number,
  tokens: SolanaPlugins['tokens'],
  decodedLegacyFund?: DecodedLegacyFund,
  fundPriceUsd?: number,
): { poolTokens: PositionValue[]; partialComposition: boolean } {
  const fundUiAmount = Number(toUiAmountString(fundAmountRaw, fundDecimals))
  if (!Number.isFinite(fundUiAmount) || fundUiAmount <= 0) {
    return {
      poolTokens: [
        buildPositionValue(
          fundDefinition.mint,
          fundAmountRaw,
          fundDecimals,
          fundPriceUsd,
        ),
      ],
      partialComposition: false,
    }
  }

  if (decodedLegacyFund && decodedLegacyFund.supplyRaw > 0n) {
    const onchainResult: PositionValue[] = []
    let partialComposition = false

    for (const component of fundDefinition.composition) {
      const componentTotalRaw =
        decodedLegacyFund.amountByTokenId.get(component.tokenId) ?? 0n
      if (componentTotalRaw <= 0n) {
        partialComposition = true
        continue
      }

      const componentToken = tokens.get(component.mint)
      const componentDecimals = componentToken?.decimals ?? component.decimals
      const componentRawAmount =
        (componentTotalRaw * fundAmountRaw) / decodedLegacyFund.supplyRaw
      if (componentRawAmount <= 0n) {
        partialComposition = true
        continue
      }

      const componentPriceUsd = tokens.get(component.mint)?.priceUsd
      onchainResult.push(
        buildPositionValue(
          component.mint,
          componentRawAmount,
          componentDecimals,
          componentPriceUsd,
        ),
      )
    }

    return { poolTokens: onchainResult, partialComposition }
  }

  if (fundPriceUsd === undefined) {
    return { poolTokens: [], partialComposition: true }
  }

  const fundUsdValue = fundUiAmount * fundPriceUsd

  const result: PositionValue[] = []
  let pricedComponents = 0
  for (const component of fundDefinition.composition) {
    const componentToken = tokens.get(component.mint)
    const componentPriceUsd = tokens.get(component.mint)?.priceUsd
    if (!componentPriceUsd || componentPriceUsd <= 0) continue
    pricedComponents++

    const componentDecimals = componentToken?.decimals ?? component.decimals
    const componentUsdValue =
      (fundUsdValue * component.weightBps) / HUNDRED_PERCENT_BPS
    const componentUiAmount = componentUsdValue / componentPriceUsd
    const componentRawAmount = BigInt(
      Math.floor(componentUiAmount * 10 ** componentDecimals),
    )

    if (componentRawAmount <= 0n) continue

    result.push(
      buildPositionValue(
        component.mint,
        componentRawAmount,
        componentDecimals,
        componentPriceUsd,
      ),
    )
  }

  return {
    poolTokens: result,
    partialComposition: pricedComponents < fundDefinition.composition.length,
  }
}

function estimateLegacyFundPriceUsdFromComponents(
  fundDefinition: (typeof LEGACY_FUNDS)[number],
  tokens: SolanaPlugins['tokens'],
): number | undefined {
  let weightedPriceSum = 0
  let totalWeight = 0

  for (const component of fundDefinition.composition) {
    const componentPrice = tokens.get(component.mint)?.priceUsd
    if (!componentPrice || componentPrice <= 0) continue
    weightedPriceSum += componentPrice * component.weightBps
    totalWeight += component.weightBps
  }

  if (totalWeight === 0) return undefined
  return weightedPriceSum / totalWeight
}

function isVaultPdaValid(mint: string, vaultAddress: string): boolean {
  try {
    const [derivedVaultAddress] = PublicKey.findProgramAddressSync(
      [VAULT_PDA_SEED, new PublicKey(mint).toBuffer()],
      new PublicKey(SYMMETRY_VAULTS_V3_PROGRAM_ID),
    )
    return derivedVaultAddress.toBase58() === vaultAddress
  } catch {
    return false
  }
}

export function buildTokenHolderUsersFiltersByMints(
  mints: Iterable<string>,
): UsersFilter[] {
  const tokenProgramId = TOKEN_PROGRAM_ID.toBase58()
  const filters: UsersFilter[] = []

  for (const mint of new Set(mints)) {
    let mintBytes: Uint8Array
    try {
      mintBytes = new PublicKey(mint).toBytes()
    } catch {
      continue
    }

    filters.push({
      programId: tokenProgramId,
      dataSize: 165,
      ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
      memcmps: [{ offset: TOKEN_ACCOUNT_MINT_OFFSET, bytes: mintBytes }],
    })
  }

  return filters
}

export const symmetryIntegration: SolanaIntegration = {
  platformId: 'symmetry',

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
        kind: 'getTokenAccountsByOwner' as const,
        owner: wallet.toBase58(),
        programId: TOKEN_PROGRAM_ID.toBase58(),
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]

    const userVaultBalancesByMint = new Map<string, bigint>()

    for (const account of Object.values(phase0Map)) {
      if (!account.exists) continue

      if (
        account.programAddress !== TOKEN_PROGRAM_ID.toBase58() &&
        account.programAddress !== TOKEN_2022_PROGRAM_ID.toBase58()
      ) {
        continue
      }

      const mint = readPubkey(account.data, TOKEN_ACCOUNT_MINT_OFFSET)
      const amountRaw = readU64(account.data, TOKEN_ACCOUNT_AMOUNT_OFFSET)
      if (!mint || amountRaw === null || amountRaw <= 0n) continue

      userVaultBalancesByMint.set(
        mint,
        (userVaultBalancesByMint.get(mint) ?? 0n) + amountRaw,
      )
    }

    if (userVaultBalancesByMint.size === 0) return []

    const derivedVaultByMint = new Map<string, string>()
    for (const mint of userVaultBalancesByMint.keys()) {
      const [vaultAddress] = PublicKey.findProgramAddressSync(
        [VAULT_PDA_SEED, new PublicKey(mint).toBuffer()],
        new PublicKey(SYMMETRY_VAULTS_V3_PROGRAM_ID),
      )
      derivedVaultByMint.set(mint, vaultAddress.toBase58())
    }

    const phase1Map = yield [...derivedVaultByMint.values()]

    const matchedVaultByMint = new Map<string, string>()
    for (const [mint, vaultAddress] of derivedVaultByMint.entries()) {
      const vaultAccount = phase1Map[vaultAddress]
      if (!vaultAccount?.exists) continue
      if (vaultAccount.programAddress !== SYMMETRY_VAULTS_V3_PROGRAM_ID)
        continue
      matchedVaultByMint.set(mint, vaultAddress)
    }

    const legacyMints = LEGACY_FUNDS.map((fund) => fund.mint).filter(
      (mint) => (userVaultBalancesByMint.get(mint) ?? 0n) > 0n,
    )

    const legacyFundLookupMaps =
      legacyMints.length > 0
        ? yield legacyMints.map((mint) => ({
            kind: 'getProgramAccounts' as const,
            programId: SYMMETRY_LEGACY_FUNDS_PROGRAM_ID,
            cacheTtlMs: ONE_HOUR_IN_MS,
            filters: [
              {
                memcmp: {
                  offset: LEGACY_FUND_MINT_OFFSET,
                  bytes: mint,
                  encoding: 'base58' as const,
                },
              },
            ],
          }))
        : ({} as Record<string, MaybeSolanaAccount>)

    const decodedLegacyFundByMint = new Map<string, DecodedLegacyFund>()
    for (const mint of legacyMints) {
      const fundDefinition = LEGACY_FUNDS.find((fund) => fund.mint === mint)
      if (!fundDefinition) continue

      const candidates: DecodedLegacyFund[] = []
      for (const account of Object.values(legacyFundLookupMaps)) {
        if (!account.exists) continue
        if (account.programAddress !== SYMMETRY_LEGACY_FUNDS_PROGRAM_ID)
          continue
        if (readPubkey(account.data, LEGACY_FUND_MINT_OFFSET) !== mint) continue
        const decoded = decodeLegacyFund(account.data)
        if (decoded) candidates.push(decoded)
      }

      const selected = selectBestLegacyFundDecoded(fundDefinition, candidates)
      if (selected) {
        decodedLegacyFundByMint.set(mint, selected)
      }
    }

    const vaultSnapshots: Array<{
      vaultAddress: string
      vaultMint: string
      vaultVersion: number
      lpDecimals: number
      userLpAmountRaw: bigint
      supplyOutstandingRaw: bigint
      assets: DecodedVaultAsset[]
    }> = []

    for (const [mint, vaultAddress] of matchedVaultByMint.entries()) {
      const vaultAccount = phase1Map[vaultAddress]
      if (!vaultAccount?.exists) continue
      if (vaultAccount.programAddress !== SYMMETRY_VAULTS_V3_PROGRAM_ID)
        continue

      const decodedVault = decodeVault(vaultAccount.data)
      if (!decodedVault) continue
      if (decodedVault.mint !== mint) continue
      if (decodedVault.supplyOutstandingRaw === 0n) continue

      vaultSnapshots.push({
        vaultAddress,
        vaultMint: mint,
        vaultVersion: decodedVault.version,
        lpDecimals: tokens.get(mint)?.decimals ?? 0,
        userLpAmountRaw: userVaultBalancesByMint.get(mint) ?? 0n,
        supplyOutstandingRaw: decodedVault.supplyOutstandingRaw,
        assets: decodedVault.assets,
      })
    }

    const mintsMissingDecimals = new Set<string>()
    for (const snapshot of vaultSnapshots) {
      if (tokens.get(snapshot.vaultMint)?.decimals === undefined) {
        mintsMissingDecimals.add(snapshot.vaultMint)
      }
      for (const asset of snapshot.assets) {
        if (tokens.get(asset.mint)?.decimals === undefined) {
          mintsMissingDecimals.add(asset.mint)
        }
      }
    }
    for (const legacyFund of LEGACY_FUNDS) {
      const fundAmountRaw = userVaultBalancesByMint.get(legacyFund.mint) ?? 0n
      if (
        fundAmountRaw > 0n &&
        tokens.get(legacyFund.mint)?.decimals === undefined
      ) {
        mintsMissingDecimals.add(legacyFund.mint)
      }
    }

    const missingDecimalsMap =
      mintsMissingDecimals.size > 0
        ? yield [...mintsMissingDecimals]
        : ({} as Record<string, MaybeSolanaAccount>)

    const positions: ConstantProductLiquidityDefiPosition[] = []

    for (const snapshot of vaultSnapshots) {
      if (snapshot.userLpAmountRaw <= 0n) continue

      const lpDecimals =
        tokens.get(snapshot.vaultMint)?.decimals ??
        readMintDecimals(missingDecimalsMap[snapshot.vaultMint]) ??
        snapshot.lpDecimals

      const poolTokens: PositionValue[] = []

      for (const asset of snapshot.assets) {
        const userAmountRaw =
          (asset.amountRaw * snapshot.userLpAmountRaw) /
          snapshot.supplyOutstandingRaw

        if (userAmountRaw <= 0n) continue

        const decimals =
          tokens.get(asset.mint)?.decimals ??
          readMintDecimals(missingDecimalsMap[asset.mint]) ??
          0
        const tokenInfo = tokens.get(asset.mint)

        poolTokens.push(
          buildPositionValue(
            asset.mint,
            userAmountRaw,
            decimals,
            tokenInfo?.priceUsd,
          ),
        )
      }

      if (poolTokens.length === 0) {
        const vaultTokenInfo = tokens.get(snapshot.vaultMint)
        poolTokens.push(
          buildPositionValue(
            snapshot.vaultMint,
            snapshot.userLpAmountRaw,
            lpDecimals,
            vaultTokenInfo?.priceUsd,
          ),
        )
      }

      const usdValue = sumUsdValues(poolTokens.map((token) => token.usdValue))

      positions.push({
        platformId: 'symmetry',
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        poolAddress: snapshot.vaultAddress,
        lpTokenAmount: toUiAmountString(snapshot.userLpAmountRaw, lpDecimals),
        poolTokens,
        ...(usdValue !== undefined && { usdValue }),
        meta: {
          symmetry: {
            vaultAddress: snapshot.vaultAddress,
            vaultMint: snapshot.vaultMint,
            vaultVersion: snapshot.vaultVersion,
            userVaultAmountRaw: snapshot.userLpAmountRaw.toString(),
            activeAssetCount: snapshot.assets.length,
          },
        },
      } satisfies ConstantProductLiquidityDefiPosition)
    }

    for (const legacyFund of LEGACY_FUNDS) {
      if (matchedVaultByMint.has(legacyFund.mint)) continue

      const fundAmountRaw = userVaultBalancesByMint.get(legacyFund.mint) ?? 0n
      if (fundAmountRaw <= 0n) continue

      const fundDecimals =
        tokens.get(legacyFund.mint)?.decimals ??
        readMintDecimals(missingDecimalsMap[legacyFund.mint]) ??
        0
      const directFundPriceUsd = tokens.get(legacyFund.mint)?.priceUsd
      const estimatedFundPriceUsd =
        directFundPriceUsd ??
        estimateLegacyFundPriceUsdFromComponents(legacyFund, tokens)
      const fundPriceUsd = directFundPriceUsd ?? estimatedFundPriceUsd

      const legacyBuild = buildLegacyFundPoolTokens(
        legacyFund,
        fundAmountRaw,
        fundDecimals,
        tokens,
        decodedLegacyFundByMint.get(legacyFund.mint),
        fundPriceUsd,
      )
      let poolTokens: PositionValue[] = legacyBuild.poolTokens
      const partialComposition = legacyBuild.partialComposition

      if (poolTokens.length === 0) {
        poolTokens = [
          buildPositionValue(
            legacyFund.mint,
            fundAmountRaw,
            fundDecimals,
            directFundPriceUsd ?? estimatedFundPriceUsd,
          ),
        ]
      }

      if (poolTokens.length === 0) continue

      const estimatedComposition = poolTokens.some(
        (token) => token.amount.token !== legacyFund.mint,
      )
      const pricingFallbackUsed =
        directFundPriceUsd === undefined && estimatedFundPriceUsd !== undefined

      const usdValue = sumUsdValues(poolTokens.map((token) => token.usdValue))

      positions.push({
        platformId: 'symmetry',
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        poolAddress: legacyFund.mint,
        lpTokenAmount: toUiAmountString(fundAmountRaw, fundDecimals),
        poolTokens,
        ...(usdValue !== undefined && { usdValue }),
        meta: {
          symmetry: {
            legacyFund: legacyFund.name,
            fundMint: legacyFund.mint,
            fundAmountRaw: fundAmountRaw.toString(),
            estimatedComposition,
            partialComposition,
            pricingFallbackUsed,
          },
        },
      } satisfies ConstantProductLiquidityDefiPosition)
    }

    positions.sort((left, right) =>
      (left.poolAddress ?? '').localeCompare(right.poolAddress ?? ''),
    )

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions as UserDefiPosition[]
  },

  getUsersFilter: async function* (): UsersFilterPlan {
    const vaultAccounts = yield {
      kind: 'getProgramAccounts' as const,
      programId: SYMMETRY_VAULTS_V3_PROGRAM_ID,
      cacheTtlMs: ONE_HOUR_IN_MS,
      filters: [],
    }

    const discoveredMints = new Set<string>()
    for (const account of Object.values(vaultAccounts)) {
      if (!account.exists) continue
      if (account.programAddress !== SYMMETRY_VAULTS_V3_PROGRAM_ID) continue

      const decodedVault = decodeVault(account.data)
      if (!decodedVault) continue
      if (decodedVault.supplyOutstandingRaw === 0n) continue
      if (!isVaultPdaValid(decodedVault.mint, account.address)) continue

      discoveredMints.add(decodedVault.mint)
    }

    for (const legacyFund of LEGACY_FUNDS) {
      discoveredMints.add(legacyFund.mint)
    }

    return buildTokenHolderUsersFiltersByMints(discoveredMints)
  },
}

export default symmetryIntegration
