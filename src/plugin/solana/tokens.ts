import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SolanaAddress } from '../../types/solanaIntegration'

export interface TokenCreator {
  address: SolanaAddress
  verified: boolean
  share: number
}

export interface TokenData {
  mintAddress: SolanaAddress
  decimals: number
  // On-chain Metaplex metadata
  name?: string
  symbol?: string
  uri?: string
  updateAuthority?: string
  isMutable?: boolean
  creators?: TokenCreator[]
  // Off-chain JSON metadata (fetched from uri)
  description?: string
  image?: string
  // Price data
  priceUsd?: number
  pctPriceChange24h?: number
}

export type TokensMap = Map<SolanaAddress, TokenData>
type TokenMarketData = { priceUsd: number; pctPriceChange24h?: number }
type TokenCacheRow = { token_address: string; token_data: string }

export class TokenPlugin {
  private map: TokensMap = new Map()
  private db: Database
  private upsertTokenStmt: ReturnType<Database['prepare']>

  constructor(cachePath = '.cache/tokens.sqlite') {
    const directory = dirname(cachePath)
    if (directory !== '.') {
      mkdirSync(directory, { recursive: true })
    }

    this.db = new Database(cachePath)

    const tableInfo = this.db
      .query('PRAGMA table_info(tokens)')
      .all() as Array<{ name: string }>
    const hasTokenAddress = tableInfo.some(
      (column) => column.name === 'token_address',
    )
    const hasTokenData = tableInfo.some(
      (column) => column.name === 'token_data',
    )
    const hasLegacyMintAddress = tableInfo.some(
      (column) => column.name === 'mint_address',
    )
    const hasLegacyData = tableInfo.some((column) => column.name === 'data')

    if (
      !hasTokenAddress &&
      !hasTokenData &&
      hasLegacyMintAddress &&
      hasLegacyData
    ) {
      this.db.run(
        'ALTER TABLE tokens RENAME COLUMN mint_address TO token_address',
      )
      this.db.run('ALTER TABLE tokens RENAME COLUMN data TO token_data')
    }

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

    for (const { token_address, token_data } of this.readCacheRows()) {
      try {
        const tokenData = JSON.parse(token_data) as TokenData
        if (tokenData?.mintAddress) {
          this.map.set(token_address, tokenData)
        }
      } catch {
        // Invalid row payload — skip this token and continue
      }
    }
  }

  /** Refresh price fields from sqlite without discarding in-memory metadata. */
  async refreshPricesFromCache(): Promise<number> {
    let pricedTokenCount = 0

    for (const { token_address, token_data } of this.readCacheRows()) {
      try {
        const cachedToken = JSON.parse(token_data) as TokenData
        if (!cachedToken?.mintAddress) continue

        const cachedPriceUsd = cachedToken.priceUsd
        const hasValidPrice =
          typeof cachedPriceUsd === 'number' && Number.isFinite(cachedPriceUsd)
        if (hasValidPrice) pricedTokenCount += 1

        const token = this.map.get(token_address)
        if (token == null) {
          this.map.set(token_address, cachedToken)
          continue
        }

        if (hasValidPrice) {
          token.priceUsd = cachedPriceUsd
        } else {
          delete token.priceUsd
        }

        const cachedPctPriceChange24h = cachedToken.pctPriceChange24h
        if (
          typeof cachedPctPriceChange24h === 'number' &&
          Number.isFinite(cachedPctPriceChange24h)
        ) {
          token.pctPriceChange24h = cachedPctPriceChange24h
        } else {
          delete token.pctPriceChange24h
        }
      } catch {
        // Invalid row payload — skip this token and continue
      }
    }

    return pricedTokenCount
  }

  /** Persist selected token(s) from in-memory cache to sqlite. If no mint list is provided, persists current full map. */
  async save(tokenAddresses?: readonly SolanaAddress[]): Promise<void> {
    const entries:
      | IterableIterator<[SolanaAddress, TokenData]>
      | Array<[SolanaAddress, TokenData]> =
      tokenAddresses == null
        ? this.map.entries()
        : tokenAddresses.flatMap((mint) => {
            const tokenData = this.map.get(mint)
            return tokenData === undefined ? [] : [[mint, tokenData]]
          })

    this.db.run('BEGIN')
    try {
      for (const [tokenAddress, tokenData] of entries) {
        this.upsertTokenStmt.run(tokenAddress, JSON.stringify(tokenData))
      }
      this.db.run('COMMIT')
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  /** Get a token from the in-memory cache. */
  get(mint: SolanaAddress): TokenData | undefined {
    return this.map.get(mint)
  }

  /** Add a single token to the in-memory cache. */
  set(mint: SolanaAddress, data: TokenData): void {
    this.map.set(mint, data)
  }

  /** Batch add tokens to the in-memory cache. */
  setMany(entries: ReadonlyMap<SolanaAddress, TokenData>): void {
    for (const [mint, data] of entries) {
      this.map.set(mint, data)
    }
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
  get tokens(): ReadonlyMap<SolanaAddress, TokenData> {
    return this.map
  }

  private readCacheRows(): TokenCacheRow[] {
    try {
      return this.db
        .query('SELECT token_address, token_data FROM tokens')
        .all() as TokenCacheRow[]
    } catch {
      // Backward compatibility for older schema name if present
      try {
        const legacyRows = this.db
          .query('SELECT mint_address, data FROM tokens')
          .all() as Array<{
          mint_address: string
          data: string
        }>
        return legacyRows.map((row) => ({
          token_address: row.mint_address,
          token_data: row.data,
        }))
      } catch {
        // Table missing or unreadable — start with empty cache
        return []
      }
    }
  }
}
