import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import { driftIntegration, testAddress } from '.'

testIntegration(driftIntegration, testAddress)

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

describe('drift integration metadata', () => {
  it('includes subaccount names in position metadata', async () => {
    const getUserPositions = driftIntegration.getUserPositions
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

    const lendingPositions = positions.filter(
      (position) => position.positionKind === 'lending',
    )
    const stakingPositions = positions.filter(
      (position) => position.positionKind === 'staking',
    )

    expect(lendingPositions.length).toBeGreaterThan(0)
    expect(stakingPositions.length).toBeGreaterThan(0)

    for (const position of lendingPositions) {
      expect(typeof position.meta?.subaccount).toBe('object')
      expect(typeof position.meta?.subaccount?.name).toBe('string')
      expect(position.meta?.subaccount?.name).not.toBe('')
    }

    for (const position of stakingPositions) {
      const vault = position.meta?.vault as Record<string, unknown> | undefined
      const earnings = position.meta?.earnings as
        | Record<string, unknown>
        | undefined
      const earningsAmount = earnings?.amount as
        | Record<string, unknown>
        | undefined

      expect(position.meta?.vault).toBeObject()
      expect(vault?.kind).toBe('insurance-fund')
      expect(typeof vault?.name).toBe('string')
      expect(vault?.name).not.toBe('')
      expect(position.meta?.earnings).toBeObject()
      expect(typeof earnings?.amount).toBe('object')
      expect(typeof earningsAmount?.amount).toBe('string')
    }
  }, 60000)
})
