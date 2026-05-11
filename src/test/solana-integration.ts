import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import type { SolanaIntegration } from '../types/index'
import { runIntegrations, TokenPlugin } from '../types/index'
import { fetchAccountsBatch, fetchProgramAccountsBatch } from '../utils/solana'

export function testIntegration(
  integration: SolanaIntegration,
  testAddress?: string,
  options?: {
    timeoutMs?: number
  },
) {
  const rpcUrl =
    process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
  const timeoutMs = options?.timeoutMs ?? 60_000

  describe(`${integration.platformId} integration`, () => {
    const getUserPositions = integration.getUserPositions
    if (getUserPositions && testAddress) {
      it(
        'getUserPositions',
        async () => {
          const connection = new Connection(rpcUrl, 'confirmed')
          const tokens = new TokenPlugin()
          const plugins = { endpoint: rpcUrl, tokens }

          let totalBatches = 0
          let totalAccounts = 0

          const [positions] = await runIntegrations(
            [getUserPositions(testAddress, plugins)],
            async (addrs) => {
              totalBatches++
              totalAccounts += addrs.length
              console.log(
                `  batch ${totalBatches}: fetching ${addrs.length} accounts`,
              )
              return fetchAccountsBatch(connection, addrs)
            },
            (req) => fetchProgramAccountsBatch(connection, req),
          )

          console.log(
            `\n✓ getUserPositions → ${positions?.length ?? 0} positions (${totalBatches} batches, ${totalAccounts} accounts)`,
          )
          if (positions) {
            for (const position of positions) {
              console.log(JSON.stringify(position, null, 2))
            }
          }

          expect(Array.isArray(positions)).toBe(true)
        },
        timeoutMs,
      )
    }

    if (integration.getTvl) {
      it('getTvl', async () => {
        const tokens = new TokenPlugin()
        const plugins = { endpoint: rpcUrl, tokens }
        const tvl = await integration.getTvl?.(plugins)
        console.log(`\n✓ getTvl → ${tvl}`)
        expect(typeof tvl).toBe('string')
      }, 30_000)
    }

    if (integration.getVolume) {
      it('getVolume', async () => {
        const tokens = new TokenPlugin()
        const plugins = { endpoint: rpcUrl, tokens }
        const vol = await integration.getVolume?.(plugins)
        console.log(`\n✓ getVolume → ${vol}`)
        expect(typeof vol).toBe('string')
      }, 30_000)
    }

    if (integration.getDailyActiveUsers) {
      it('getDailyActiveUsers', async () => {
        const tokens = new TokenPlugin()
        const plugins = { endpoint: rpcUrl, tokens }
        const dau = await integration.getDailyActiveUsers?.(plugins)
        console.log(`\n✓ getDailyActiveUsers → ${dau}`)
        expect(typeof dau).toBe('string')
      }, 30_000)
    }
  })
}
