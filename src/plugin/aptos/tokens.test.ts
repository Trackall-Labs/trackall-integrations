import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk'

import { type AptosTokenData, AptosTokenPlugin } from './tokens'

const MOVEMENT_RPC_URL =
  process.env.MOVEMENT_RPC_URL ?? 'https://mainnet.movementnetwork.xyz/v1'
const movementClient = new Aptos(
  new AptosConfig({
    network: Network.CUSTOM,
    fullnode: MOVEMENT_RPC_URL,
    clientConfig: { http2: false },
  }),
)
const TARGET_TOKEN_COUNT = 100
const TOKEN_ADDRESSES_FILE = new URL('./token-addresses.json', import.meta.url)
let cachedAddresses: string[] | null = null

async function loadAptosTokenAddresses(): Promise<string[]> {
  if (cachedAddresses != null) return cachedAddresses

  const cached = (await Bun.file(TOKEN_ADDRESSES_FILE).json()) as string[]
  cachedAddresses = [
    ...new Set(
      cached.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      ),
    ),
  ]
  return cachedAddresses
}

function testDbPath(name: string): string {
  return join(
    process.cwd(),
    '.cache',
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  )
}

function createTokensTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      token_address TEXT PRIMARY KEY,
      token_data TEXT NOT NULL
    )
  `)
}

function queryRows(
  dbPath: string,
): Array<{ token_address: string; token_data: string }> {
  const db = new Database(dbPath, { strict: true })
  try {
    return db
      .query('SELECT token_address, token_data FROM tokens')
      .all() as Array<{
      token_address: string
      token_data: string
    }>
  } finally {
    db.close()
  }
}

function closeAptosTokenPluginDb(plugin: AptosTokenPlugin): void {
  ;(plugin as unknown as { db: Database }).db.close()
}

function closeAndDeleteDb(plugin: AptosTokenPlugin, dbPath: string): void {
  closeAptosTokenPluginDb(plugin)
  void Bun.file(dbPath).delete()
}

describe('AptosTokenPlugin', () => {
  describe('price updates', () => {
    it('updates price fields and clears stale 24h change when missing', () => {
      const plugin = new AptosTokenPlugin({} as unknown as Aptos, ':memory:')
      const token: AptosTokenData = {
        tokenId: '0x1::aptos_coin::AptosCoin',
        standard: 'coin',
        decimals: 8,
        priceUsd: 1,
        pctPriceChange24h: 4,
      }
      ;(plugin as unknown as { map: Map<string, AptosTokenData> }).map.set(
        token.tokenId,
        token,
      )

      const updated = plugin.updatePrices(
        new Map([
          ['0x1::aptos_coin::AptosCoin', { priceUsd: 1.5 }],
          [
            '0x2::aptos_coin::AnotherCoin',
            { priceUsd: 2.5, pctPriceChange24h: 1 },
          ],
        ]),
      )

      expect(updated).toEqual(['0x1::aptos_coin::AptosCoin'])
      expect(plugin.get('0x1::aptos_coin::AptosCoin')?.priceUsd).toBe(1.5)
      expect(
        plugin.get('0x1::aptos_coin::AptosCoin')?.pctPriceChange24h,
      ).toBeUndefined()

      closeAptosTokenPluginDb(plugin)
    })
  })

  describe('fetchMany()', () => {
    it('accepts exactly 100 addresses and rejects 101', async () => {
      const tokenAddresses = await loadAptosTokenAddresses()
      if (tokenAddresses.length < TARGET_TOKEN_COUNT + 1) {
        throw new Error(
          `Expected at least ${TARGET_TOKEN_COUNT + 1} token addresses, got ${
            tokenAddresses.length
          }`,
        )
      }

      const plugin = new AptosTokenPlugin(movementClient)
      const exactlyLimit = tokenAddresses.slice(0, TARGET_TOKEN_COUNT)
      await expect(plugin.fetchMany(exactlyLimit)).resolves.toBeInstanceOf(Map)

      const tooMany = tokenAddresses.slice(0, TARGET_TOKEN_COUNT + 1)
      const uncachedCheckPlugin = new AptosTokenPlugin(movementClient)
      await expect(uncachedCheckPlugin.fetchMany(tooMany)).rejects.toThrow(
        `fetchMany supports at most ${TARGET_TOKEN_COUNT} token ids per call`,
      )
    }, 60_000)

    it('returns undefined for unknown token identifier', async () => {
      const plugin = new AptosTokenPlugin(movementClient)
      const result = await plugin.fetchMany([
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef::unknown::Token',
      ])
      expect(
        result.get(
          '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef::unknown::Token',
        ),
      ).toBeUndefined()
    }, 10_000)

    it('resolves MOVE coin type: decimals=8, symbol=MOVE, standard=coin', async () => {
      const plugin = new AptosTokenPlugin(movementClient)
      const move = '0x1::aptos_coin::AptosCoin'
      const result = await plugin.fetch(move)
      expect(result).toBeDefined()
      if (!result) throw new Error('MOVE token not found')
      expect(result.decimals).toBe(8)
      expect(result.symbol).toBe('MOVE')
      expect(result.standard).toBe('coin')
    }, 10_000)
  })

  describe('SQLite cache', () => {
    it('loads valid token rows and skips malformed rows', async () => {
      const dbPath = testDbPath('aptos-tokens-load')
      const db = new Database(dbPath)
      createTokensTable(db)

      const validToken: AptosTokenData = {
        tokenId: '0x1::aptos_coin::AptosCoin',
        standard: 'coin',
        decimals: 8,
        name: 'Move Coin',
        symbol: 'MOVE',
      }

      const validInsert = db.prepare(
        'INSERT INTO tokens (token_address, token_data) VALUES (?, ?)',
      )
      validInsert.run(validToken.tokenId, JSON.stringify(validToken))
      db.prepare(
        'INSERT INTO tokens (token_address, token_data) VALUES (?, ?)',
      ).run('bad-identifier', '{ this is: not json }')
      db.close()

      const plugin = new AptosTokenPlugin({} as unknown as Aptos, dbPath)
      await plugin.load()

      expect(plugin.get(validToken.tokenId)).toEqual(validToken)
      expect(plugin.get('bad-identifier')).toBeUndefined()

      closeAndDeleteDb(plugin, dbPath)
    })

    it('saves only explicitly requested token ids', async () => {
      const dbPath = testDbPath('aptos-tokens-save-specified')
      const db = new Database(dbPath)
      createTokensTable(db)

      const initialToken: AptosTokenData = {
        tokenId: '0x2::some_module::TokenB',
        standard: 'coin',
        decimals: 6,
        name: 'Old Token B',
        symbol: 'BTOK',
      }
      db.prepare(
        'INSERT INTO tokens (token_address, token_data) VALUES (?, ?)',
      ).run(initialToken.tokenId, JSON.stringify(initialToken))
      db.close()

      const plugin = new AptosTokenPlugin({} as unknown as Aptos, dbPath)
      await plugin.load()

      const pluginAny = plugin as unknown as {
        map: Map<string, AptosTokenData>
      }
      const tokenA: AptosTokenData = {
        tokenId: '0x3::some_module::TokenA',
        standard: 'fungible_asset',
        decimals: 4,
        name: 'New Token A',
        symbol: 'ATOK',
      }
      const updatedTokenB: AptosTokenData = {
        tokenId: '0x2::some_module::TokenB',
        standard: 'coin',
        decimals: 8,
        name: 'Should Not Persist',
        symbol: 'BUPD',
      }

      pluginAny.map.set(tokenA.tokenId, tokenA)
      pluginAny.map.set(updatedTokenB.tokenId, updatedTokenB)
      await plugin.save([tokenA.tokenId])

      const rows = queryRows(dbPath)
      expect(rows).toHaveLength(2)

      const tokenARow = rows.find((r) => r.token_address === tokenA.tokenId)
      const tokenBRow = rows.find(
        (r) => r.token_address === initialToken.tokenId,
      )

      expect(tokenARow).toBeDefined()
      expect(tokenBRow).toBeDefined()
      if (!tokenARow || !tokenBRow) throw new Error('rows not found')

      const loadedTokenA = JSON.parse(tokenARow.token_data) as AptosTokenData
      const loadedTokenB = JSON.parse(tokenBRow.token_data) as AptosTokenData

      expect(loadedTokenA).toEqual(tokenA)
      expect(loadedTokenB).toEqual(initialToken)

      closeAndDeleteDb(plugin, dbPath)
    })

    it('persists full map when save called without args', async () => {
      const dbPath = testDbPath('aptos-tokens-save-full')
      const plugin = new AptosTokenPlugin({} as unknown as Aptos, dbPath)
      const pluginAny = plugin as unknown as {
        map: Map<string, AptosTokenData>
      }

      const token: AptosTokenData = {
        tokenId: '0x4::some_module::TokenC',
        standard: 'coin',
        decimals: 3,
        name: 'Full Save Token',
        symbol: 'C',
      }
      pluginAny.map.set(token.tokenId, token)

      await plugin.save()
      const rows = queryRows(dbPath)

      expect(rows).toHaveLength(1)
      const row = rows[0]
      if (!row) throw new Error('row not found')
      expect(JSON.parse(row.token_data)).toEqual(token)

      closeAndDeleteDb(plugin, dbPath)
    })

    it('skips rows missing tokenId field', async () => {
      const dbPath = testDbPath('aptos-tokens-missing-tokenid')
      const db = new Database(dbPath)
      createTokensTable(db)

      db.prepare(
        'INSERT INTO tokens (token_address, token_data) VALUES (?, ?)',
      ).run(
        '0x5::some_module::TokenD',
        JSON.stringify({ standard: 'coin', decimals: 6, name: 'No ID Token' }),
      )
      db.close()

      const plugin = new AptosTokenPlugin({} as unknown as Aptos, dbPath)
      await plugin.load()

      expect(plugin.get('0x5::some_module::TokenD')).toBeUndefined()
      expect(plugin.tokens.size).toBe(0)

      closeAndDeleteDb(plugin, dbPath)
    })
  })
})
