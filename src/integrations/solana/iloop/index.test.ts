import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import { iloopIntegration, testAddress } from '.'

testIntegration(iloopIntegration, testAddress)

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

describe('iloop integration shape', () => {
  it('returns lending positions with iloop metadata', async () => {
    const getUserPositions = iloopIntegration.getUserPositions
    if (!getUserPositions) throw new Error('getUserPositions not implemented')

    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    const [positions] = await runIntegrations(
      [getUserPositions(testAddress, plugins)],
      (addresses) => fetchAccountsBatch(connection, addresses),
      (req) => fetchProgramAccountsBatch(connection, req),
    )

    if (!positions) throw new Error('No results returned')

    expect(positions.length).toBeGreaterThan(0)
    for (const position of positions) {
      expect(position.platformId).toBe('iloop')
      expect(position.positionKind).toBe('lending')
      expect(position.meta?.iloop).toBeObject()
      expect(typeof position.meta?.iloop?.obligation).toBe('string')
      expect(typeof position.meta?.iloop?.lendingMarket).toBe('string')
      expect(['loop', 'supply']).toContain(String(position.meta?.iloop?.tag))
    }
  }, 60000)
})
