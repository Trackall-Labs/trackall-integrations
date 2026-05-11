import { afterEach, describe, expect, it } from 'bun:test'
import type { Connection } from '@solana/web3.js'
import type { AccountsMap } from '../types/index'
import { fetchProgramAccountsBatch } from './solana'

const originalFetch = globalThis.fetch
const dummyConnection = {} as Connection

function setFetch(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = handler as unknown as typeof fetch
}

function decodeHttpJsonRow(map: AccountsMap, key: string): unknown {
  const account = map[key]
  if (!account?.exists) throw new Error(`Missing account for key: ${key}`)
  return JSON.parse(Buffer.from(account.data).toString('utf8')) as unknown
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchProgramAccountsBatch getHttpJson', () => {
  it('parses object.data arrays and keyField rows', async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'vault-a', apy: '1.11' },
              { id: 'vault-b', apy: '2.22' },
            ],
          }),
        ),
    )

    const map = await fetchProgramAccountsBatch(dummyConnection, {
      kind: 'getHttpJson',
      url: 'https://example.com/data-array',
      keyField: 'id',
    })

    expect(map['vault-a']?.exists).toBe(true)
    expect(map['vault-b']?.exists).toBe(true)
    expect(decodeHttpJsonRow(map, 'vault-a')).toEqual({
      id: 'vault-a',
      apy: '1.11',
    })
    expect(decodeHttpJsonRow(map, 'vault-b')).toEqual({
      id: 'vault-b',
      apy: '2.22',
    })
  })

  it('parses top-level arrays', async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify([
            { strategy: 'strategy-1', totalApy: '3.14' },
            { strategy: 'strategy-2', totalApy: '2.71' },
          ]),
        ),
    )

    const url = 'https://example.com/top-level-array'
    const map = await fetchProgramAccountsBatch(dummyConnection, {
      kind: 'getHttpJson',
      url,
    })

    expect(map[`${url}#0`]?.exists).toBe(true)
    expect(map[`${url}#1`]?.exists).toBe(true)
    expect(decodeHttpJsonRow(map, `${url}#0`)).toEqual({
      strategy: 'strategy-1',
      totalApy: '3.14',
    })
  })

  it('parses top-level objects as a single row', async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify({
            apy: '4.56',
            apyActual: '4.44',
          }),
        ),
    )

    const url = 'https://example.com/top-level-object'
    const map = await fetchProgramAccountsBatch(dummyConnection, {
      kind: 'getHttpJson',
      url,
    })

    expect(Object.keys(map)).toHaveLength(1)
    expect(map[`${url}#0`]?.exists).toBe(true)
    expect(decodeHttpJsonRow(map, `${url}#0`)).toEqual({
      apy: '4.56',
      apyActual: '4.44',
    })
  })

  it('uses cacheTtlMs for repeated requests', async () => {
    let fetchCallCount = 0
    setFetch(async () => {
      fetchCallCount += 1
      const payload =
        fetchCallCount === 1
          ? { data: [{ value: 'first' }] }
          : { data: [{ value: 'second' }] }
      return new Response(JSON.stringify(payload))
    })

    const url = 'https://example.com/cache-ttl-check'
    const req = {
      kind: 'getHttpJson' as const,
      url,
      cacheTtlMs: 60_000,
    }

    const first = await fetchProgramAccountsBatch(dummyConnection, req)
    const second = await fetchProgramAccountsBatch(dummyConnection, req)

    expect(fetchCallCount).toBe(1)
    expect(decodeHttpJsonRow(first, `${url}#0`)).toEqual({ value: 'first' })
    expect(decodeHttpJsonRow(second, `${url}#0`)).toEqual({ value: 'first' })
  })
})
