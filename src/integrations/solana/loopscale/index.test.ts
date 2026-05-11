import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import { loopscaleIntegration, testAddress } from '.'

testIntegration(loopscaleIntegration, testAddress)

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

describe('loopscale integration shape', () => {
  it('includes strategy positions and vault valuation metadata', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    const getUserPositions = loopscaleIntegration.getUserPositions
    if (!getUserPositions) throw new Error('getUserPositions not implemented')

    const [positions] = await runIntegrations(
      [getUserPositions(testAddress, plugins)],
      (addresses) => fetchAccountsBatch(connection, addresses),
      (req) => fetchProgramAccountsBatch(connection, req),
    )
    if (!positions) throw new Error('No positions returned')

    const strategyPositions = positions.filter(
      (position) => position.meta?.loopscale?.source === 'strategy',
    )
    expect(strategyPositions.length).toBeGreaterThan(0)

    const vaultedPositions = positions.filter((position) =>
      ['vault-stake', 'vault-deposit'].includes(
        String(position.meta?.loopscale?.source ?? ''),
      ),
    )
    expect(vaultedPositions.length).toBeGreaterThan(0)
    for (const position of vaultedPositions) {
      const valuationSource = String(
        position.meta?.loopscale?.valuationSource ?? '',
      )
      expect(valuationSource).toBe('strategy-nav')
    }
  }, 60000)
})
