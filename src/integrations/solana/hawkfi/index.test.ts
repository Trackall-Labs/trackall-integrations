import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import { hawkfiIntegration, testAddress } from './index'

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

testIntegration(hawkfiIntegration, testAddress, { timeoutMs: 120_000 })

describe('hawkfi integration details', () => {
  it('fetches live HawkFi positions for the test wallet', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }
    const getUserPositions = hawkfiIntegration.getUserPositions
    if (!getUserPositions) throw new Error('getUserPositions not implemented')

    const [positions] = await runIntegrations(
      [getUserPositions(testAddress, plugins)],
      (addresses) => fetchAccountsBatch(connection, addresses),
      (req) => fetchProgramAccountsBatch(connection, req),
    )

    if (!positions) throw new Error('No positions result returned')

    console.log(`Found ${positions.length} HawkFi positions`)
    if (positions[0]) {
      console.log('Sample position:', JSON.stringify(positions[0], null, 2))
    }

    expect(positions.length).toBeGreaterThan(0)
    for (const position of positions) {
      expect(position.platformId).toBe('hawkfi')
      expect(typeof position.meta?.hawkfi?.hawkfiAccount).toBe('string')
      expect(typeof position.meta?.hawkfi?.underlyingPlatform).toBe('string')
    }
  }, 120_000)

  it('indexes HawkFi state accounts by wallet owner', () => {
    const filters = hawkfiIntegration.getUsersFilter?.()
    if (!Array.isArray(filters)) {
      throw new Error('expected static HawkFi users filters')
    }

    expect(filters).toHaveLength(1)
    expect(filters[0]).toEqual({
      programId: 'FqGg2Y1FNxMiGd51Q6UETixQWkF5fB92MysbYogRJb3P',
      ownerOffset: 8,
      dataSize: 752,
      discriminator: Uint8Array.from(Buffer.from('kBHyBxNrrXY=', 'base64')),
    })
  })
})
