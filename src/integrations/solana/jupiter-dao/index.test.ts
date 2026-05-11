import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import type {
  StakingDefiPosition,
  UserPositionsPlan,
} from '../../../types/index'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import { jupiterDaoIntegration, testAddress } from './index'

const solanaRpcUrl = process.env.SOLANA_RPC_URL
if (!solanaRpcUrl) {
  throw new Error(
    'SOLANA_RPC_URL is required. Set it in your environment or .env.',
  )
}

const wallets = [
  testAddress,
  '5LurCmpQxeQpssfDECZzY3w9wCD5QexZ6QZ1CWNZATEo',
  '71kG5LnbjVFp3Grj7VZ8WCqTNU6XRihoPuHRTMvmZGKb',
]

const { getUserPositions } = jupiterDaoIntegration
if (!getUserPositions) throw new Error('getUserPositions not implemented')

describe('jupiter-dao integration', () => {
  it('fetches staking and ASR reward positions for the primary wallet', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0
    let totalProgramRequests = 0

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
      (req) => {
        totalProgramRequests++
        return fetchProgramAccountsBatch(connection, req)
      },
    )

    if (!positions) throw new Error('No results returned')

    const stakingPositions = positions.filter(
      (position): position is StakingDefiPosition =>
        position.positionKind === 'staking',
    )

    console.log(`\nFound ${positions.length} Jupiter DAO positions`)
    console.log(
      `RPC batches: ${totalBatches}, total accounts fetched: ${totalAccounts}`,
    )
    console.log('Positions:', JSON.stringify(positions, null, 2))

    expect(stakingPositions.length).toBeGreaterThan(0)

    expect(totalProgramRequests).toBe(2)
  }, 60000)

  it('fetches positions for multiple wallets in batched RPC calls', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0
    let totalProgramRequests = 0
    let naiveTotal = 0
    const programRequestsByWallet = new Map<string, number>()

    function trackYields(
      wallet: string,
      plan: UserPositionsPlan,
    ): UserPositionsPlan {
      return (async function* (): UserPositionsPlan {
        let step = await plan.next()
        while (!step.done) {
          if (Array.isArray(step.value)) {
            if (step.value.length > 0 && typeof step.value[0] === 'string') {
              naiveTotal += step.value.length
            } else {
              const current = programRequestsByWallet.get(wallet) ?? 0
              programRequestsByWallet.set(wallet, current + step.value.length)
            }
          } else {
            const current = programRequestsByWallet.get(wallet) ?? 0
            programRequestsByWallet.set(wallet, current + 1)
          }
          const accounts = yield step.value
          step = await plan.next(accounts)
        }
        return step.value
      })()
    }

    const results = await runIntegrations(
      wallets.map((wallet) =>
        trackYields(wallet, getUserPositions(wallet, plugins)),
      ),
      async (addresses) => {
        totalBatches++
        totalAccounts += addresses.length
        console.log(
          `  batch ${totalBatches}: fetching ${addresses.length} accounts`,
        )
        return fetchAccountsBatch(connection, addresses)
      },
      (req) => {
        totalProgramRequests++
        return fetchProgramAccountsBatch(connection, req)
      },
    )

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

    expect(totalProgramRequests).toBeLessThanOrEqual(wallets.length * 2)
    wallets.forEach((wallet, index) => {
      const walletProgramRequests = programRequestsByWallet.get(wallet) ?? 0
      const hasStakingPosition = (results[index] ?? []).some(
        (position) => position.positionKind === 'staking',
      )
      expect(walletProgramRequests).toBeLessThanOrEqual(2)
      if (hasStakingPosition) {
        expect(walletProgramRequests).toBe(2)
      }
    })
  }, 60000)
})
