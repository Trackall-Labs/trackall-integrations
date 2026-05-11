import { describe, expect, it } from 'bun:test'
import { borrowPda } from '@jup-ag/lend'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import type {
  GetProgramAccountsRequest,
  ProgramRequest,
  UserPositionsPlan,
  UsersFilterPlan,
} from '../../../types/index'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
  ONE_MINUTE_IN_MS,
} from '../../../utils/solana'
import lendingIdl from './idls/lending.json'
import vaultsIdl from './idls/vaults.json'
import {
  applyRateMagnifierToScale,
  buildTokenHolderUsersFiltersByMints,
  buildVaultPositionLookupRequest,
  calculateEarnBaseSupplyRateScaled,
  calculateTokenReserveAnnualRatesScaled,
  denormalizeVaultAmount,
  deriveUserLiquidityPositionPdas,
  formatScaledRate,
  jupiterLendIntegration,
  testAddress,
} from './index'

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const wallets = [testAddress]

const { getUserPositions, getUsersFilter } = jupiterLendIntegration
if (!getUserPositions) throw new Error('getUserPositions not implemented')
if (!getUsersFilter) throw new Error('getUsersFilter not implemented')

function isNumericString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value)
}

describe('jupiter-lend integration', () => {
  it('starts discovery without full Position account scan', async () => {
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }
    const plan = getUserPositions(wallets[0] ?? testAddress, plugins)

    const first = await plan.next()
    if (first.done) throw new Error('Expected discovery requests')
    if (!Array.isArray(first.value)) throw new Error('Expected request array')

    const requests = first.value as ProgramRequest[]
    const vaultProgramRequests = requests.filter(
      (req): req is GetProgramAccountsRequest =>
        req.kind === 'getProgramAccounts' &&
        req.programId === vaultsIdl.address,
    )
    const tokenOwnerRequests = requests.filter(
      (
        req,
      ): req is Extract<ProgramRequest, { kind: 'getTokenAccountsByOwner' }> =>
        req.kind === 'getTokenAccountsByOwner',
    )

    expect(vaultProgramRequests).toHaveLength(3)
    expect(tokenOwnerRequests).toHaveLength(2)
    expect(new Set(tokenOwnerRequests.map((req) => req.programId))).toEqual(
      new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]),
    )
    expect(
      tokenOwnerRequests.every((req) => req.cacheTtlMs === ONE_MINUTE_IN_MS),
    ).toBe(true)

    await plan.return([])
  })

  it('starts users filter discovery from Jupiter lending accounts', async () => {
    const plan = getUsersFilter() as UsersFilterPlan

    const first = await plan.next()
    if (first.done) throw new Error('Expected discovery request')
    if (Array.isArray(first.value)) {
      throw new Error('Expected a single discovery request')
    }
    if (first.value.kind !== 'getProgramAccounts') {
      throw new Error('Expected getProgramAccounts request')
    }

    expect(first.value.kind).toBe('getProgramAccounts')
    expect(first.value.programId).toBe(lendingIdl.address)
    expect(first.value.filters).toHaveLength(1)
    expect(first.value.filters[0]).toEqual({
      memcmp: {
        offset: 0,
        bytes: Buffer.from(
          lendingIdl.accounts.find((account) => account.name === 'Lending')
            ?.discriminator ?? [],
        ).toString('base64'),
        encoding: 'base64',
      },
    })

    const done = await plan.next({})
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')
    expect(Array.from(done.value)).toEqual([])
  })

  it('builds holder filters for discovered mints on both token programs', () => {
    const mintA = 'So11111111111111111111111111111111111111112'
    const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

    const filters = buildTokenHolderUsersFiltersByMints([mintA, mintB, mintA])
    expect(filters).toHaveLength(2)

    const pairs = new Set(
      filters.map((filter) => {
        const mintBytes = filter.memcmps?.[0]?.bytes
        if (!mintBytes) throw new Error('Expected mint memcmp bytes')
        return `${filter.programId}:${new PublicKey(mintBytes).toBase58()}`
      }),
    )

    expect(pairs).toEqual(
      new Set([
        `${TOKEN_PROGRAM_ID.toBase58()}:${mintA}`,
        `${TOKEN_PROGRAM_ID.toBase58()}:${mintB}`,
      ]),
    )
  })

  it('builds targeted vault position lookup request by position mint', () => {
    const mint = 'So11111111111111111111111111111111111111112'
    const req = buildVaultPositionLookupRequest(mint)
    if (req.kind !== 'getProgramAccounts') {
      throw new Error('Expected getProgramAccounts request')
    }

    expect(req.kind).toBe('getProgramAccounts')
    expect(req.programId).toBe(vaultsIdl.address)
    expect(req.filters).toHaveLength(2)
    expect(req.filters[1]).toEqual({
      memcmp: {
        offset: 14,
        bytes: mint,
        encoding: 'base58',
      },
    })
  })

  it('derives both user supply and borrow position PDAs for mint/protocol', () => {
    const mint = 'So11111111111111111111111111111111111111112'
    const protocol = '3n8muNMSAzM64M56gH8zvQHceQ3yvGN28AL5soMgqdD8'

    const derived = deriveUserLiquidityPositionPdas(mint, protocol)
    expect(derived).not.toBeNull()

    const mintPk = new PublicKey(mint)
    const protocolPk = new PublicKey(protocol)
    expect(derived?.supplyPositionAddress).toBe(
      borrowPda.getUserSupplyPosition(mintPk, protocolPk).toBase58(),
    )
    expect(derived?.borrowPositionAddress).toBe(
      borrowPda.getUserBorrowPosition(mintPk, protocolPk).toBase58(),
    )
  })

  it('denormalizes vault amounts for mints with decimals lower than 9', () => {
    expect(denormalizeVaultAmount(1027578000n, 6)).toBe(1027578n)
    expect(denormalizeVaultAmount(165631n, 8)).toBe(16563n)
    expect(denormalizeVaultAmount(38557779n, 9)).toBe(38557779n)
    expect(denormalizeVaultAmount(12345n, 10)).toBe(12345n)
  })

  it('derives reserve annual supply and borrow rates from onchain reserve fields', () => {
    const rates = calculateTokenReserveAnnualRatesScaled({
      mint: 'So11111111111111111111111111111111111111112',
      borrowRate: 4000, // 40%
      feeOnInterest: 1000, // 10%
      lastUtilization: 6000, // 60%
      supplyExchangePrice: 1_000_000_000_000n,
      borrowExchangePrice: 1_000_000_000_000n,
      totalSupplyWithInterest: 80n,
      totalSupplyInterestFree: 20n,
      totalBorrowWithInterest: 50n,
      totalBorrowInterestFree: 10n,
    })

    expect(rates).not.toBeNull()
    expect(rates?.borrowRateScaled).toBe(400000000000n) // 0.4
    expect(rates?.supplyRateScaled).toBe(225000000000n) // 0.225
  })

  it('returns zero supply rate when there is no with-interest borrow', () => {
    const rates = calculateTokenReserveAnnualRatesScaled({
      mint: 'So11111111111111111111111111111111111111112',
      borrowRate: 3200,
      feeOnInterest: 500,
      lastUtilization: 5500,
      supplyExchangePrice: 1_000_000_000_000n,
      borrowExchangePrice: 1_000_000_000_000n,
      totalSupplyWithInterest: 1_000_000n,
      totalSupplyInterestFree: 0n,
      totalBorrowWithInterest: 0n,
      totalBorrowInterestFree: 100_000n,
    })

    expect(rates).not.toBeNull()
    expect(rates?.borrowRateScaled).toBe(320000000000n)
    expect(rates?.supplyRateScaled).toBe(0n)
  })

  it('applies vault rate magnifiers as signed annual bps deltas', () => {
    expect(applyRateMagnifierToScale(60000000000n, 150)).toBe(75000000000n) // 0.06 + 0.015
    expect(applyRateMagnifierToScale(60000000000n, -200)).toBe(40000000000n) // 0.06 - 0.02
  })

  it('formats scaled annual rates as percentage strings', () => {
    expect(formatScaledRate(400000000000n)).toBe('40')
    expect(formatScaledRate(225000000000n)).toBe('22.5')
    expect(formatScaledRate(0n)).toBe('0')
    expect(formatScaledRate(-400000000000n)).toBe('-40')
  })

  it('derives earn base supply rate using with-interest value ratio', () => {
    const supplyRateScaled = calculateEarnBaseSupplyRateScaled({
      mint: 'So11111111111111111111111111111111111111112',
      borrowRate: 4000, // 40%
      feeOnInterest: 1000, // 10%
      lastUtilization: 0,
      supplyExchangePrice: 1_000_000_000_000n,
      borrowExchangePrice: 1_000_000_000_000n,
      totalSupplyWithInterest: 20n,
      totalSupplyInterestFree: 80n,
      totalBorrowWithInterest: 50n,
      totalBorrowInterestFree: 10n,
    })

    expect(supplyRateScaled).toBe(900000000000n) // 0.9
  })

  it('fetches user supply positions', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0

    const [positions] = await runIntegrations(
      [getUserPositions(wallets[0] ?? testAddress, plugins)],
      async (addresses) => {
        totalBatches++
        totalAccounts += addresses.length
        console.log(
          `  batch ${totalBatches}: fetching ${addresses.length} accounts`,
        )
        return fetchAccountsBatch(connection, addresses)
      },
      (req) => fetchProgramAccountsBatch(connection, req),
    )

    if (!positions) throw new Error('No results returned')

    const lendingPositions = positions.filter(
      (p) => p.positionKind === 'lending',
    )

    console.log(
      `\nFound ${positions.length} Jupiter Lend positions for ${testAddress.slice(0, 8)}…`,
    )
    console.log(
      `RPC batches: ${totalBatches}, total accounts fetched: ${totalAccounts}`,
    )
    console.log('Positions:', JSON.stringify(lendingPositions, null, 2))

    expect(Array.isArray(positions)).toBe(true)
    for (const position of lendingPositions) {
      if (position.positionKind !== 'lending') continue
      if (position.apy !== undefined) {
        expect(isNumericString(position.apy)).toBe(true)
      }
      for (const supplied of position.supplied ?? []) {
        if (supplied.supplyRate !== undefined) {
          expect(isNumericString(supplied.supplyRate)).toBe(true)
        }
      }
      for (const borrowed of position.borrowed ?? []) {
        if (borrowed.borrowRate !== undefined) {
          expect(isNumericString(borrowed.borrowRate)).toBe(true)
        }
      }
    }
  }, 60000)

  it('fetches positions for multiple wallets in batched RPC calls', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0
    let naiveTotal = 0

    function trackYields(plan: UserPositionsPlan): UserPositionsPlan {
      return (async function* (): UserPositionsPlan {
        let step = await plan.next()
        while (!step.done) {
          if (Array.isArray(step.value)) naiveTotal += step.value.length
          const accounts = yield step.value
          step = await plan.next(accounts)
        }
        return step.value
      })()
    }

    const results = await runIntegrations(
      wallets.map((w) => trackYields(getUserPositions(w, plugins))),
      async (addresses) => {
        totalBatches++
        totalAccounts += addresses.length
        console.log(
          `  batch ${totalBatches}: fetching ${addresses.length} accounts`,
        )
        return fetchAccountsBatch(connection, addresses)
      },
      (req) => fetchProgramAccountsBatch(connection, req),
    )

    const totalPositions = results.reduce((sum, p) => sum + p.length, 0)
    const saved = naiveTotal - totalAccounts
    const savedPct = naiveTotal > 0 ? Math.round((saved / naiveTotal) * 100) : 0
    console.log(
      `\n${wallets.length} wallets → ${totalPositions} total positions`,
    )
    console.log(
      `RPC batches: ${totalBatches}, actual accounts fetched: ${totalAccounts}`,
    )
    console.log(
      `Sequential would have fetched: ${naiveTotal} — saved ${saved} (${savedPct}%)`,
    )
    wallets.forEach((w, i) => {
      console.log(`  ${w.slice(0, 8)}…  ${results[i]?.length ?? 0} positions`)
    })

    expect(results).toHaveLength(wallets.length)
    for (const positions of results) {
      expect(Array.isArray(positions)).toBe(true)
    }
  }, 60000)
})
