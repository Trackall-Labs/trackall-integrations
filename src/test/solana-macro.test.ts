import { describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { Connection } from '@solana/web3.js'
import type { SolanaIntegration } from '../types/index'
import { runIntegrations, TokenPlugin } from '../types/index'
import { fetchAccountsBatch, fetchProgramAccountsBatch } from '../utils/solana'

type SolanaIntegrationModule = {
  default?: SolanaIntegration
  testAddress?: string
}

const rpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
console.log('Using RPC URL:', rpcUrl)
const integrationsDir = new URL('../integrations/solana/', import.meta.url)

type RpcRequestFn = (
  methodName: string,
  args: Array<unknown>,
) => Promise<unknown>
type ConnectionWithRpcRequest = Connection & {
  _rpcRequest: RpcRequestFn
}

function preview(value: unknown, limit = 160): string {
  const text = JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

const integrationDirs = (
  await readdir(integrationsDir, { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const integrations = await Promise.all(
  integrationDirs.map(async (dir) => {
    const mod = (await import(
      new URL(`${dir}/index.ts`, integrationsDir).href
    )) as SolanaIntegrationModule

    return {
      dir,
      integration: mod.default,
      testAddress: mod.testAddress,
      name: mod.default?.platformId ?? dir,
      hasUserPositions: Boolean(mod.default?.getUserPositions),
      hasTestAddress: Boolean(mod.testAddress),
    }
  }),
)

describe('solana integrations getUserPositions macro', () => {
  for (const integration of integrations) {
    if (!integration.hasUserPositions) {
      it.skip(`skips ${integration.name} (getUserPositions not implemented)`, () => {})
      continue
    }

    if (!integration.hasTestAddress) {
      it.skip(`skips ${integration.name} (testAddress missing)`, () => {})
      continue
    }

    it(`calls getUserPositions for ${integration.name}`, async () => {
      const connection = new Connection(rpcUrl, 'confirmed')
      const connectionWithRpcRequest =
        connection as unknown as ConnectionWithRpcRequest
      const rpcRequest = connectionWithRpcRequest._rpcRequest.bind(connection)

      connectionWithRpcRequest._rpcRequest = async (methodName, params) => {
        const start = Date.now()

        console.log(
          `[${integration.name}] RPC ${methodName} params=${preview(params ?? [], 320)}`,
        )

        try {
          const response = await rpcRequest(methodName, params ?? [])
          console.log(
            `[${integration.name}] RPC ${methodName} OK in ${Date.now() - start}ms`,
          )
          return response
        } catch (error) {
          console.error(
            `[${integration.name}] RPC ${methodName} FAIL after ${Date.now() - start}ms`,
          )
          if (error instanceof Error) {
            console.error(error.message)
          } else {
            console.error(error)
          }
          throw error
        }
      }

      const tokens = new TokenPlugin()
      const plugins = { endpoint: rpcUrl, tokens }

      let totalBatches = 0
      let totalAccounts = 0

      if (
        !integration.integration?.getUserPositions ||
        !integration.testAddress
      ) {
        throw new Error(`[${integration.name}] Missing test integration config`)
      }

      const [positions] = await runIntegrations(
        [
          integration.integration.getUserPositions(
            integration.testAddress,
            plugins,
          ),
        ],
        async (addrs) => {
          totalBatches++
          totalAccounts += addrs.length
          console.log(
            `[${integration.name}] fetchAccountsBatch addrs=${addrs.length}`,
          )
          return fetchAccountsBatch(connection, addrs)
        },
        (req) => {
          console.log(
            `[${integration.name}] fetchProgramAccountsBatch kind=${req.kind} programId=${req.kind === 'getProgramAccounts' ? req.programId : 'n/a'} owner=${req.kind === 'getTokenAccountsByOwner' ? req.owner : 'n/a'}`,
          )
          return fetchProgramAccountsBatch(connection, req)
        },
      )
      if (!positions) {
        throw new Error(`[${integration.name}] No positions array returned`)
      }

      console.log(
        `\n[${integration.name}] getUserPositions → ${positions.length} positions (${totalBatches} batches, ${totalAccounts} accounts)`,
      )

      expect(Array.isArray(positions)).toBe(true)
    }, 120_000)
  }
})
