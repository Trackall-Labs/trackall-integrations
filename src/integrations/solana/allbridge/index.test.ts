import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import { allbridgeIntegration, testAddress } from './index'

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

const { getUserPositions } = allbridgeIntegration
if (!getUserPositions) throw new Error('getUserPositions not implemented')

describe('allbridge integration', () => {
  it('fetches user positions using getProgramAccounts only', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalAccountBatches = 0
    let totalAccountsFetched = 0
    let getProgramAccountsCalls = 0
    const otherProgramKinds = new Set<string>()

    const [positions] = await runIntegrations(
      [getUserPositions(testAddress, plugins)],
      async (addresses) => {
        totalAccountBatches++
        totalAccountsFetched += addresses.length
        console.log(
          `  account batch ${totalAccountBatches}: fetching ${addresses.length} accounts`,
        )
        return fetchAccountsBatch(connection, addresses)
      },
      (req) => {
        if (req.kind === 'getProgramAccounts') {
          getProgramAccountsCalls++
        } else {
          otherProgramKinds.add(req.kind)
        }

        console.log(
          `  program request ${getProgramAccountsCalls}: kind=${req.kind} programId=${
            req.kind === 'getProgramAccounts' ? req.programId : 'n/a'
          }`,
        )
        return fetchProgramAccountsBatch(connection, req)
      },
    )

    if (!positions) throw new Error('No results returned')

    console.log(`\nFound ${positions.length} Allbridge positions`)
    console.log(
      `Address batches: ${totalAccountBatches}, accounts fetched: ${totalAccountsFetched}`,
    )
    console.log(`getProgramAccounts calls: ${getProgramAccountsCalls}`)

    if (positions.length > 0) {
      console.log('Sample position:', JSON.stringify(positions[0], null, 2))
    }

    expect(Array.isArray(positions)).toBe(true)
    expect(getProgramAccountsCalls).toBeGreaterThan(0)
    expect(totalAccountBatches).toBe(0)
    expect(otherProgramKinds.size).toBe(0)
  }, 60000)
})
