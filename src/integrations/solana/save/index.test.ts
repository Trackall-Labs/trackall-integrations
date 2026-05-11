import { describe, expect, it } from 'bun:test'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import type {
  AccountsMap,
  ProgramRequest,
  UserPositionsPlan,
} from '../../../types/index'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
  ONE_MINUTE_IN_MS,
} from '../../../utils/solana'
import { saveIntegration, testAddress } from './index'

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const wallets = ['BcVL3ZxEDwsnzx3LLks3fV8DUDtj5gpVZLBHUvfVSvRw']
const SAVE_PROGRAM_ID = 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo'
const OBLIGATION_OWNER_OFFSET = 42
const RESERVE_ACCOUNT_SIZE = 619
const RESERVE_MARKET_OFFSET = 10
const RESERVE_LIQUIDITY_MINT_OFFSET = 42
const RESERVE_LIQUIDITY_DECIMALS_OFFSET = 74
const RESERVE_LIQUIDITY_AVAILABLE_AMOUNT_OFFSET = 171
const RESERVE_COLLATERAL_MINT_OFFSET = 227
const RESERVE_COLLATERAL_MINT_TOTAL_SUPPLY_OFFSET = 259

const { getUserPositions } = saveIntegration
if (!getUserPositions) throw new Error('getUserPositions not implemented')

function isProgramRequestArray(value: unknown): value is ProgramRequest[] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'kind' in entry &&
      !('platformId' in entry),
  )
}

function writePubkey(buf: Buffer, offset: number, pubkey: PublicKey): void {
  pubkey.toBuffer().copy(buf, offset)
}

function buildTokenAccountData(
  mint: PublicKey,
  amount: bigint,
  size = 165,
): Uint8Array {
  const buf = Buffer.alloc(size, 0)
  writePubkey(buf, 0, mint)
  buf.writeBigUInt64LE(amount, 64)
  return new Uint8Array(buf)
}

function buildReserveAccountData(options: {
  market: PublicKey
  liquidityMint: PublicKey
  liquidityDecimals: number
  liquidityAvailableAmount: bigint
  collateralMint: PublicKey
  collateralMintTotalSupply: bigint
}): Uint8Array {
  const buf = Buffer.alloc(RESERVE_ACCOUNT_SIZE, 0)
  writePubkey(buf, RESERVE_MARKET_OFFSET, options.market)
  writePubkey(buf, RESERVE_LIQUIDITY_MINT_OFFSET, options.liquidityMint)
  buf[RESERVE_LIQUIDITY_DECIMALS_OFFSET] = options.liquidityDecimals
  buf.writeBigUInt64LE(
    options.liquidityAvailableAmount,
    RESERVE_LIQUIDITY_AVAILABLE_AMOUNT_OFFSET,
  )
  writePubkey(buf, RESERVE_COLLATERAL_MINT_OFFSET, options.collateralMint)
  buf.writeBigUInt64LE(
    options.collateralMintTotalSupply,
    RESERVE_COLLATERAL_MINT_TOTAL_SUPPLY_OFFSET,
  )
  return new Uint8Array(buf)
}

describe('save integration', () => {
  it('requests broadened phase-0 discovery patterns', async () => {
    const plan = getUserPositions(testAddress, {
      endpoint: '',
      tokens: new TokenPlugin(),
    })

    const first = await plan.next()
    expect(first.done).toBe(false)
    if (!isProgramRequestArray(first.value)) {
      throw new Error('Expected phase-0 program requests, received addresses')
    }

    const requests = first.value
    const ownerDiscovery = requests.find(
      (request) =>
        request.kind === 'getProgramAccounts' &&
        request.programId === SAVE_PROGRAM_ID &&
        request.filters.some(
          (filter) =>
            'memcmp' in filter &&
            filter.memcmp.offset === OBLIGATION_OWNER_OFFSET &&
            filter.memcmp.bytes === testAddress,
        ),
    )
    expect(ownerDiscovery).toBeDefined()
    if (!ownerDiscovery || ownerDiscovery.kind !== 'getProgramAccounts') {
      throw new Error('Expected Save obligation owner discovery request')
    }

    expect(ownerDiscovery.filters.some((f) => 'dataSize' in f)).toBe(false)

    const tokenRequests = requests.filter(
      (request) => request.kind === 'getTokenAccountsByOwner',
    )
    expect(tokenRequests).toHaveLength(2)
    expect(new Set(tokenRequests.map((request) => request.programId))).toEqual(
      new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]),
    )
    expect(
      tokenRequests.every((request) => request.cacheTtlMs === ONE_MINUTE_IN_MS),
    ).toBe(true)

    await plan.return([])
  })

  it('detects collateral-only balances from SPL and Token-2022 discovery', async () => {
    const collateralMint = new PublicKey(
      'GwhrcyPhqXssYHDE4CaMuLMYxqeRKqUfg1WVig9yVR4g',
    )
    const liquidityMint = new PublicKey(
      'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu',
    )
    const market = new PublicKey('HeVhqRY3i22om5a7WGYftAJ2NjJJ3Cg5jnmMCsfFhRG8')
    const reserveAddress = 'FewrTs5PrbpWMXwoBuu9qiUASF3GgwxdNfXwNdqusxnV'

    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    const [positions] = await runIntegrations(
      [getUserPositions(testAddress, plugins)],
      async () => ({}),
      async (request: ProgramRequest): Promise<AccountsMap> => {
        if (request.kind === 'getTokenAccountsByOwner') {
          if (request.programId === TOKEN_PROGRAM_ID.toBase58()) {
            return {
              splCollateralAta: {
                exists: true,
                address: 'splCollateralAta',
                lamports: 0n,
                programAddress: TOKEN_PROGRAM_ID.toBase58(),
                data: buildTokenAccountData(collateralMint, 400n),
              },
            }
          }
          if (request.programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
            return {
              token2022CollateralAta: {
                exists: true,
                address: 'token2022CollateralAta',
                lamports: 0n,
                programAddress: TOKEN_2022_PROGRAM_ID.toBase58(),
                data: buildTokenAccountData(collateralMint, 600n, 256),
              },
            }
          }
          return {}
        }

        if (request.kind !== 'getProgramAccounts') return {}

        const isOwnerDiscovery = request.filters.some(
          (filter) =>
            'memcmp' in filter &&
            filter.memcmp.offset === OBLIGATION_OWNER_OFFSET &&
            filter.memcmp.bytes === testAddress,
        )
        if (isOwnerDiscovery) return {}

        const isReserveDiscovery = request.filters.some(
          (filter) =>
            'dataSize' in filter && filter.dataSize === RESERVE_ACCOUNT_SIZE,
        )
        if (!isReserveDiscovery) return {}

        return {
          [reserveAddress]: {
            exists: true,
            address: reserveAddress,
            lamports: 0n,
            programAddress: SAVE_PROGRAM_ID,
            data: buildReserveAccountData({
              market,
              liquidityMint,
              liquidityDecimals: 9,
              liquidityAvailableAmount: 1000n,
              collateralMint,
              collateralMintTotalSupply: 1000n,
            }),
          },
        }
      },
    )

    if (!positions) throw new Error('No results returned')
    expect(positions).toHaveLength(1)
    expect(positions[0]?.positionKind).toBe('lending')

    const position = positions[0]
    if (!position || position.positionKind !== 'lending') {
      throw new Error('Expected lending position')
    }

    expect(position.supplied).toBeDefined()
    expect(position.supplied).toHaveLength(1)
    expect(position.supplied?.[0]?.amount.token).toBe(liquidityMint.toBase58())
    expect(position.supplied?.[0]?.amount.amount).toBe('1000')
    expect(position.meta).toEqual({
      source: {
        type: 'wallet-collateral',
      },
    })
  })

  it('fetches user positions', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0

    const [positions] = await runIntegrations(
      [getUserPositions(testAddress, plugins)],
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

    console.log(`\nFound ${positions.length} positions`)
    console.log(
      `RPC batches: ${totalBatches}, total accounts fetched: ${totalAccounts}`,
    )
    if (positions.length > 0) {
      console.log('Sample position:', JSON.stringify(positions[0], null, 2))
    }

    expect(Array.isArray(positions)).toBe(true)
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
      wallets.map((wallet) => trackYields(getUserPositions(wallet, plugins))),
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
    console.log(JSON.stringify(results))
    const totalPositions = results.reduce(
      (sum, positions) => sum + positions.length,
      0,
    )
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
    wallets.forEach((wallet, index) => {
      console.log(
        `  ${wallet.slice(0, 8)}…  ${results[index]?.length ?? 0} positions`,
      )
    })

    expect(results).toHaveLength(wallets.length)
    for (const positions of results) {
      expect(Array.isArray(positions)).toBe(true)
    }
  }, 60000)
})
