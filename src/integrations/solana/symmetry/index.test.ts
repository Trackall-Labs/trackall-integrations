import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import type {
  ConstantProductLiquidityDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
} from '../../../types/index'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import { symmetryIntegration, testAddress } from '.'

const solanaRpcUrl = process.env.SOLANA_RPC_URL
if (!solanaRpcUrl) {
  throw new Error(
    'SOLANA_RPC_URL is required. Set it in your environment or .env.',
  )
}

const LEGACY_YSOL_MINT = '3htQDAvEx53jyMJ2FVHeztM5BRjfmNuBqceXu1fJRqWx'
const V3_JUPSOL_POOL = 'C2SpNsmPB91ne4JdQRYZZdTJXkMLWyHfMSaZCS9nB33J'

const wallets = [testAddress, '5G8GY87rWJ9GGfV22T87jxWprHP4fXvvaA7fEE8pqWWy']

function isConstantProductLiquidity(
  position: UserDefiPosition,
): position is ConstantProductLiquidityDefiPosition {
  return (
    position.positionKind === 'liquidity' &&
    position.liquidityModel === 'constant-product'
  )
}

describe('symmetry integration', () => {
  const getUserPositions = symmetryIntegration.getUserPositions
  if (!getUserPositions) throw new Error('getUserPositions not implemented')

  it('fetches V3 and legacy ySOL positions', async () => {
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
    const liquidityPositions = positions.filter(isConstantProductLiquidity)

    const v3Position = liquidityPositions.find(
      (position) => position.poolAddress === V3_JUPSOL_POOL,
    )
    const legacyPosition = liquidityPositions.find(
      (position) => position.poolAddress === LEGACY_YSOL_MINT,
    )

    console.log(`\nFound ${positions.length} symmetry positions`)
    console.log(
      `RPC batches: ${totalBatches}, total accounts fetched: ${totalAccounts}`,
    )
    console.log('Positions:', JSON.stringify(positions, null, 2))

    expect(v3Position).toBeDefined()
    expect(legacyPosition).toBeDefined()
    expect((legacyPosition?.poolTokens.length ?? 0) > 1).toBe(true)
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

    const totalPositions = results.reduce(
      (sum, positions) => sum + positions.length,
      0,
    )
    const saved = naiveTotal - totalAccounts
    const savedPct = naiveTotal > 0 ? Math.round((saved / naiveTotal) * 100) : 0

    console.log(
      `\n${wallets.length} wallets -> ${totalPositions} total positions`,
    )
    console.log(
      `RPC batches: ${totalBatches}, actual accounts fetched: ${totalAccounts}`,
    )
    console.log(
      `Sequential would have fetched: ${naiveTotal} - saved ${saved} (${savedPct}%)`,
    )

    expect(results).toHaveLength(wallets.length)
    expect(
      results[0]
        ?.filter(isConstantProductLiquidity)
        .some((position) => position.poolAddress === LEGACY_YSOL_MINT),
    ).toBe(true)
  }, 60000)
})
