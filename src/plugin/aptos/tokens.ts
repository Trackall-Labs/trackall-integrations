import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Aptos } from '@aptos-labs/ts-sdk'

export type AptosTokenIdentifier = string
export type AptosTokenStandard = 'coin' | 'fungible_asset'

export interface AptosTokenData {
  tokenId: AptosTokenIdentifier
  standard: AptosTokenStandard
  decimals: number
  name?: string
  symbol?: string
  iconUri?: string
  priceUsd?: number
  pctPriceChange24h?: number
}

export type AptosTokensMap = Map<AptosTokenIdentifier, AptosTokenData>
type TokenMarketData = { priceUsd: number; pctPriceChange24h?: number }

const MAX_TOKEN_FETCH_SIZE = 100

export class AptosTokenPlugin {
  private map: AptosTokensMap = new Map()
  private client: Aptos
  private db: Database
  private upsertTokenStmt: ReturnType<Database['prepare']>

  constructor(client: Aptos, cachePath = '.cache/aptos-tokens.sqlite') {
    this.client = client
    const directory = dirname(cachePath)
    if (directory !== '.') {
      mkdirSync(directory, { recursive: true })
    }

    this.db = new Database(cachePath)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS tokens (
        token_address TEXT PRIMARY KEY,
        token_data TEXT NOT NULL
      )
    `)

    this.upsertTokenStmt = this.db.prepare(
      'INSERT INTO tokens (token_address, token_data) VALUES (?, ?) ON CONFLICT(token_address) DO UPDATE SET token_data = excluded.token_data',
    )
  }

  /** Load cache from sqlite. Call once at startup. */
  async load(): Promise<void> {
    this.map.clear()

    let rows: Array<{ token_address: string; token_data: string }> = []
    try {
      rows = this.db
        .query('SELECT token_address, token_data FROM tokens')
        .all() as Array<{
        token_address: string
        token_data: string
      }>
    } catch {
      // Table missing or unreadable — start with empty cache
    }

    for (const { token_address, token_data } of rows) {
      try {
        const tokenData = JSON.parse(token_data) as AptosTokenData
        if (tokenData?.tokenId) {
          this.map.set(token_address, tokenData)
        }
      } catch {
        // Invalid row payload — skip this token and continue
      }
    }
  }

  /** Persist selected token(s) from in-memory cache to sqlite. If no id list is provided, persists current full map. */
  async save(tokenIds?: readonly AptosTokenIdentifier[]): Promise<void> {
    const entries:
      | IterableIterator<[AptosTokenIdentifier, AptosTokenData]>
      | Array<[AptosTokenIdentifier, AptosTokenData]> =
      tokenIds == null
        ? this.map.entries()
        : tokenIds.flatMap((id) => {
            const tokenData = this.map.get(id)
            return tokenData === undefined ? [] : [[id, tokenData]]
          })

    this.db.run('BEGIN')
    try {
      for (const [tokenId, tokenData] of entries) {
        this.upsertTokenStmt.run(tokenId, JSON.stringify(tokenData))
      }
      this.db.run('COMMIT')
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  /** Get a token from the in-memory cache. */
  get(tokenId: AptosTokenIdentifier): AptosTokenData | undefined {
    return this.map.get(tokenId)
  }

  /** Fetch metadata for a token id, update in-memory and disk cache. Returns undefined if token does not exist. */
  async fetch(
    tokenId: AptosTokenIdentifier,
  ): Promise<AptosTokenData | undefined> {
    const result = await this.fetchMany([tokenId])
    return result.get(tokenId)
  }

  async fetchMany(
    tokenIds: readonly AptosTokenIdentifier[],
  ): Promise<Map<AptosTokenIdentifier, AptosTokenData | undefined>> {
    const uniqueIds = [...new Set(tokenIds)]
    if (uniqueIds.length > MAX_TOKEN_FETCH_SIZE) {
      throw new Error(
        `fetchMany supports at most ${MAX_TOKEN_FETCH_SIZE} token ids per call`,
      )
    }

    const result = new Map<AptosTokenIdentifier, AptosTokenData | undefined>()

    const uncachedIds: AptosTokenIdentifier[] = []
    for (const id of uniqueIds) {
      const cached = this.map.get(id)
      if (cached) {
        result.set(id, cached)
      } else {
        uncachedIds.push(id)
      }
    }

    if (uncachedIds.length === 0) return result

    const fetchResults = await Promise.allSettled(
      uncachedIds.map((id) => this.fetchSingleToken(id)),
    )

    const newEntries: Array<[AptosTokenIdentifier, AptosTokenData]> = []
    fetchResults.forEach((settled, index) => {
      const id = uncachedIds[index]
      if (id === undefined) return

      if (settled.status === 'fulfilled' && settled.value !== undefined) {
        result.set(id, settled.value)
        newEntries.push([id, settled.value])
      } else {
        result.set(id, undefined)
      }
    })

    if (newEntries.length > 0) {
      for (const [id, tokenData] of newEntries) {
        this.map.set(id, tokenData)
      }
      await this.save(newEntries.map(([id]) => id))
    }

    return result
  }

  /** Update price fields for tokens present in the prices map. */
  updatePrices(prices: Map<string, number | TokenMarketData>): string[] {
    const updated: string[] = []
    for (const [address, marketDataOrPrice] of prices) {
      const token = this.map.get(address)
      if (token) {
        if (typeof marketDataOrPrice === 'number') {
          token.priceUsd = marketDataOrPrice
        } else {
          token.priceUsd = marketDataOrPrice.priceUsd
          const pctPriceChange24h = marketDataOrPrice.pctPriceChange24h
          if (
            pctPriceChange24h === undefined ||
            !Number.isFinite(pctPriceChange24h)
          ) {
            delete token.pctPriceChange24h
          } else {
            token.pctPriceChange24h = pctPriceChange24h
          }
        }
        updated.push(address)
      }
    }
    return updated
  }

  /** Read-only view of the full in-memory map. */
  get tokens(): ReadonlyMap<AptosTokenIdentifier, AptosTokenData> {
    return this.map
  }

  private async fetchCoinInfo(
    coinType: string,
  ): Promise<AptosTokenData | undefined> {
    try {
      const accountAddress = coinType.split('::')[0] as `0x${string}`
      const data = await this.client.getAccountResource<{
        name: string
        symbol: string
        decimals: number
      }>({
        accountAddress,
        resourceType: `0x1::coin::CoinInfo<${coinType}>`,
      })
      return {
        tokenId: coinType,
        standard: 'coin',
        decimals: data.decimals,
        name: data.name,
        symbol: data.symbol,
      }
    } catch {
      return undefined
    }
  }

  private async fetchFungibleAssetMetadata(
    objectAddress: string,
  ): Promise<AptosTokenData | undefined> {
    try {
      const data = await this.client.getAccountResource<{
        name: string
        symbol: string
        decimals: number
        icon_uri?: string
      }>({
        accountAddress: objectAddress as `0x${string}`,
        resourceType: '0x1::fungible_asset::Metadata',
      })
      const result: AptosTokenData = {
        tokenId: objectAddress,
        standard: 'fungible_asset',
        decimals: data.decimals,
        name: data.name,
        symbol: data.symbol,
      }
      if (data.icon_uri) result.iconUri = data.icon_uri
      return result
    } catch {
      return undefined
    }
  }

  private async fetchSingleToken(
    tokenId: AptosTokenIdentifier,
  ): Promise<AptosTokenData | undefined> {
    if (tokenId.includes('::')) {
      const coinResult = await this.fetchCoinInfo(tokenId)
      if (coinResult !== undefined) return coinResult
      return this.fetchFungibleAssetMetadata(tokenId)
    } else {
      const faResult = await this.fetchFungibleAssetMetadata(tokenId)
      if (faResult !== undefined) return faResult
      return this.fetchCoinInfo(tokenId)
    }
  }
}
