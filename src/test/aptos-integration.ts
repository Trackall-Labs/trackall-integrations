import { describe, expect, it } from 'bun:test'
import { Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk'
import { AptosTokenPlugin } from '../plugin/aptos/tokens'
import type { AptosIntegration } from '../types/aptosIntegration'

export const MOVEMENT_INDEXER_URL =
  process.env.MOVEMENT_INDEXER_URL ||
  'https://indexer.mainnet.movementnetwork.xyz/v1/graphql'

export function testAptosIntegration(
  integration: AptosIntegration,
  testAddress?: string,
) {
  const rpcUrl =
    process.env.MOVEMENT_RPC_URL || 'https://mainnet.movementnetwork.xyz/v1'

  const indexerConfig = {
    indexerUrl: MOVEMENT_INDEXER_URL,
  } as {
    indexerUrl: string
  } as {
    HEADERS?: Record<string, string | number | boolean>
  }

  const aptosConfig = {
    network: Network.CUSTOM,
    fullnode: rpcUrl,
    clientConfig: { http2: false },
    indexerConfig,
  }

  const client = new Aptos(new AptosConfig(aptosConfig))

  const tokens = new AptosTokenPlugin(client)
  const plugins = { client, tokens }

  describe(`${integration.platformId} integration`, () => {
    const getUserPositions = integration.getUserPositions
    if (getUserPositions && testAddress) {
      it('getUserPositions', async () => {
        const positions = await getUserPositions(testAddress, plugins)
        console.log(`\n✓ getUserPositions → ${positions.length} positions`)
        for (const position of positions) {
          console.log(JSON.stringify(position, null, 2))
        }
        expect(Array.isArray(positions)).toBe(true)
      }, 60_000)
    }

    if (integration.getTvl) {
      it('getTvl', async () => {
        const tvl = await integration.getTvl?.(plugins)
        console.log(`\n✓ getTvl → ${tvl}`)
        expect(typeof tvl).toBe('string')
      }, 30_000)
    }

    if (integration.getVolume) {
      it('getVolume', async () => {
        const vol = await integration.getVolume?.(plugins)
        console.log(`\n✓ getVolume → ${vol}`)
        expect(typeof vol).toBe('string')
      }, 30_000)
    }

    if (integration.getDailyActiveUsers) {
      it('getDailyActiveUsers', async () => {
        const dau = await integration.getDailyActiveUsers?.(plugins)
        console.log(`\n✓ getDailyActiveUsers → ${dau}`)
        expect(typeof dau).toBe('string')
      }, 30_000)
    }
  })
}
