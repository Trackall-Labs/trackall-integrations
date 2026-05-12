---
name: new-solana-integration
description: Scaffold and implement a new Solana DeFi integration in this repo using the current generator protocol, platform metadata, shared tests, and CI flow
---

You are helping the user add a new Solana DeFi integration to the `packages/integrations` workspace. Follow the steps below in order. Ask for the protocol name (for example `orca` or `raydium`) before starting if it has not been provided.

---

## Step 1 — Gather information

Ask the user for:
1. **Protocol name** — lowercase, no spaces (becomes `<protocol>` throughout, for example `orca`)
2. **testAddress** — a Solana wallet address known to hold live positions for this protocol
3. **Platform metadata** — `name`, `image` URL, `description`, optional `defiLlamaId`, optional `tags`, optional `links`
4. **Active-user discovery needs** — ask whether active users can be described by static account owner filters, or whether additional on-chain reads are needed to discover mints, markets, vaults, or other dynamic filter inputs

If any are missing, ask before proceeding.

---

## Step 2 — Create platform metadata

Create `src/platforms/<protocol>.ts` modelled on `src/platforms/meteora.ts`:

```typescript
import type { Platform } from '../types/platform'

const <protocol>Platform = {
  id: '<protocol>' as const,
  networks: ['solana'],
  name: '<Name>',
  image: '<image-url>',
  description: '<Short description>',
  tags: [],
  defiLlamaId: '<defiLlamaId>',
} satisfies Platform

export default <protocol>Platform
```

Rules:
- `id` must be a unique string literal — it becomes the `PlatformId` union member
- `networks` must include `'solana'`
- `tags` must use valid `PlatformTag` values such as `'lending'`, `'staking'`, or `'liquidity'`
- optional fields such as `defiLlamaId` and `links` may be omitted if unknown; do not fill placeholders
- image is required and must never be omitted, empty, or undefined, image must be a direct, publicly reachable image URL, before writing the file, verify that the URL responds successfully and serves an actual image (Content-Type starts with image/), if no valid image URL can be confirmed, stop and ask the user for a different one instead of guessing

---

## Step 3 — Register in `src/platforms/index.ts`

Read the current file first, then add the import and add the platform to the existing `platforms` array while preserving the file's current style and ordering:

```typescript
import type { Platform } from '../types/platform'
import <protocol>Platform from './<protocol>'   // ← add this

export const platforms = [
  // existing platforms...
  <protocol>Platform,
] as const satisfies readonly Platform[]

export type PlatformId = typeof platforms[number]['id']
```

This automatically adds `'<protocol>'` to the `PlatformId` union used everywhere in TypeScript.

---

## Step 4 — Create `src/integrations/solana/<protocol>/index.ts`

Use the current integrations under `src/integrations/solana/` as references. `kamino` is a good reference for advanced lending/staking, token-account discovery, HTTP JSON yields, APY enrichment, and protocol-specific assertions. `meteora` is a good compact reference for liquidity and batching.

The required shape is:

```typescript
import type {
  ProgramRequest,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'

export const testAddress = '<wallet-with-known-positions>'
export const PROGRAM_IDS = [
  '<PROGRAM_ID>',
] as const

export const <protocol>Integration: SolanaIntegration = {
  platformId: '<protocol>',   // must exactly match the registered platform id

  getUserPositions: async function* (address: string, { tokens }: SolanaPlugins): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = tokens.get(token)
        if (tokenData?.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    // Phase 0: discover token accounts when balances or share mints are needed.
    const tokenAccounts = yield [
      {
        kind: 'getTokenAccountsByOwner' as const,
        owner: address,
        programId: '<TOKEN_PROGRAM_ID>',
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]
    void tokenAccounts

    // Phase 1: discover positions via getProgramAccounts.
    const phase0Map = yield {
      kind: 'getProgramAccounts' as const,
      programId: '<PROGRAM_ID>',
      filters: [/* owner filter, discriminator filter, … */],
      cacheTtlMs: ONE_HOUR_IN_MS,
    }
    void phase0Map

    // Phase 2: batch-fetch required accounts (markets, vaults, mints, etc.).
    const round1 = yield ['<account-address-1>', '<account-address-2>']
    void round1

    // Phase 3: yield external JSON metadata/APY sources through the runner when needed.
    const httpRequests: ProgramRequest[] = [
      {
        kind: 'getHttpJson' as const,
        url: 'https://api.example.com/metrics',
        cacheTtlMs: ONE_HOUR_IN_MS,
      },
    ]
    const metricsMap = yield httpRequests
    void metricsMap

    const result: UserDefiPosition[] = []
    // build and push positions …
    applyPositionsPctUsdValueChange24(tokenSource, result)
    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: '<PROGRAM_ID>',
      ownerOffset: 0,
      // discriminator, dataSize, and memcmps may be added when available.
    },
  ],

  // Optional stats methods can be added when backed by real protocol data.
}

export default <protocol>Integration
```

If active-user discovery needs extra on-chain reads, use a `UsersFilterPlan` generator instead. Model this on `src/integrations/solana/jupiter-lend/index.ts`: first yield discovery requests, decode the returned accounts, then return the final owner filters.

```typescript
getUsersFilter: async function* (): UsersFilterPlan {
  const discoveryAccounts = yield {
    kind: 'getProgramAccounts' as const,
    programId: '<PROGRAM_ID>',
    cacheTtlMs: ONE_HOUR_IN_MS,
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: '<DISCRIMINATOR_BASE64>',
          encoding: 'base64' as const,
        },
      },
    ],
  }

  const discoveredMints = new Set<string>()
  for (const account of Object.values(discoveryAccounts)) {
    if (!account.exists) continue
    // Decode the account and add dynamic mints/markets/vaults needed by filters.
  }

  return buildUsersFiltersFromDiscoveredState(discoveredMints)
}
```

Key rules:
- `export default` is **mandatory** — the package root auto-discovers integrations by reading `src/integrations/solana/*/index.ts`
- `export const testAddress` is expected for every integration with `getUserPositions`; the generic CI harness reads it from `mod.testAddress`
- Export `PROGRAM_IDS` as a top-level constant in every Solana integration; do not place `indexedPrograms` on the `SolanaIntegration` object itself
- `PROGRAM_IDS` must be a non-empty string array; CI fails if it is missing or invalid
- `platformId` must match the `id` registered in Step 2/3 exactly
- Yield `GetProgramAccountsRequest` objects (with `kind: 'getProgramAccounts'`) to discover accounts owned by a program
- Yield `GetTokenAccountsByOwnerRequest` objects (with `kind: 'getTokenAccountsByOwner'`) when token-account discovery is needed
- Yield `GetHttpJsonRequest` objects (with `kind: 'getHttpJson'`) for external JSON metadata/APY endpoints instead of calling `fetch` directly inside the integration
- Yield `ProgramRequest[]` when several program/token/HTTP requests can run in the same phase
- Yield `SolanaAddress[]` to batch-fetch arbitrary accounts
- The runner returns an `AccountsMap` (`Record<SolanaAddress, MaybeSolanaAccount>`) for each yield
- Use `cacheTtlMs` for stable or slow-changing request results, commonly `ONE_MINUTE_IN_MS` for token-account discovery and `ONE_HOUR_IN_MS` for catalogs, reserves, markets, and API metrics
- Position types available: `ConcentratedRangeLiquidityDefiPosition`, `ConstantProductLiquidityDefiPosition`, `LendingDefiPosition`, `StakingDefiPosition`, `VestingDefiPosition`, `RewardDefiPosition` — all in `src/types/`
- Use nested `rewards` only when rewards belong to a primary position; use top-level `RewardDefiPosition` for standalone claimables like airdrops
- `BaseDefiPosition` supports optional `meta?: PositionMetadata`, where `PositionMetadata = Record<string, Record<string, unknown>>`; use it only for structured protocol-specific details that do not fit shared fields, for example `meta.subaccount.name`
- After building positions, attach 24h percentage changes with `applyPositionsPctUsdValueChange24` from `src/utils/positionChange.ts`
- Always ask whether active-user discovery needs additional on-chain reads. Use `UsersFilter[]` for static filters, or a `UsersFilterPlan` generator when filters require discovery of mints, markets, vaults, or other dynamic inputs before the final owner filters can be built
- In static `getUsersFilter` results, include `programId`, `ownerOffset`, and, when available, `discriminator`, `dataSize`, and extra `memcmps`
- In generator `getUsersFilter` results, yield `ProgramRequest` or `ProgramRequest[]` discovery steps, decode returned accounts defensively, and return the final `UsersFilter[]`. Jupiter Lend is the reference: it discovers lending accounts, extracts active f-token mints, then builds token-account owner filters for those mints
- Do not stub optional stats methods with fake `'0'` values. Leave `getTvl`, `getVolume`, or `getDailyActiveUsers` undefined unless implemented from real protocol data

---

## Step 5 — Create `src/integrations/solana/<protocol>/index.test.ts`

At minimum, wire the integration to the shared Solana harness:

```typescript
import { testIntegration } from '../../../test/solana-integration'
import { <protocol>Integration, testAddress } from '.'

testIntegration(<protocol>Integration, testAddress)
```

For richer protocol-specific coverage, model after `src/integrations/solana/kamino/index.test.ts` or `src/integrations/solana/meteora/index.test.ts`. Include a direct single-wallet test and, when useful, a multi-wallet batching test:

```typescript
import { describe, expect, it } from 'bun:test'
import { Connection } from '@solana/web3.js'
import { <protocol>Integration, testAddress } from '.'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import { fetchAccountsBatch, fetchProgramAccountsBatch } from '../../../utils/solana'
import type { UserPositionsPlan } from '../../../types/index'

const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'

const wallets = [
  testAddress,
  // add 4 more wallets with known positions for multi-wallet test
]

describe('<protocol> integration', () => {
  it('fetches user positions', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0

    const [positions] = await runIntegrations(
      [<protocol>Integration.getUserPositions!(testAddress, plugins)],
      async (addresses) => {
        totalBatches++
        totalAccounts += addresses.length
        console.log(`  batch ${totalBatches}: fetching ${addresses.length} accounts`)
        return fetchAccountsBatch(connection, addresses)
      },
      (req) => fetchProgramAccountsBatch(connection, req),
    )

    if (!positions) throw new Error('No results returned')

    console.log(`\nFound ${positions.length} positions`)
    console.log(`RPC batches: ${totalBatches}, total accounts fetched: ${totalAccounts}`)
    if (positions.length > 0) {
      console.log('Sample position:', JSON.stringify(positions[0], null, 2))
    }

    expect(Array.isArray(positions)).toBe(true)
  }, 60000)

  it('fetches positions for multiple wallets in batched RPC calls', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0
    let naiveTotal = 0

    function trackYields(plan: UserPositionsPlan): UserPositionsPlan {
      return (async function* (): UserPositionsPlan {
        let step = await plan.next()
        while (!step.done) {
          if (Array.isArray(step.value)) {
            if (step.value.length > 0 && typeof step.value[0] === 'string') {
              naiveTotal += step.value.length
            }
          }
          const accounts = yield step.value
          step = await plan.next(accounts)
        }
        return step.value
      })()
    }

    const results = await runIntegrations(
      wallets.map((w) => trackYields(<protocol>Integration.getUserPositions!(w, plugins))),
      async (addresses) => {
        totalBatches++
        totalAccounts += addresses.length
        console.log(`  batch ${totalBatches}: fetching ${addresses.length} accounts`)
        return fetchAccountsBatch(connection, addresses)
      },
      (req) => fetchProgramAccountsBatch(connection, req),
    )

    const totalPositions = results.reduce((sum, p) => sum + p.length, 0)
    const saved = naiveTotal - totalAccounts
    const savedPct = naiveTotal > 0 ? Math.round((saved / naiveTotal) * 100) : 0
    console.log(`\n${wallets.length} wallets → ${totalPositions} total positions`)
    console.log(`RPC batches: ${totalBatches}, actual accounts fetched: ${totalAccounts}`)
    console.log(`Sequential would have fetched: ${naiveTotal} — saved ${saved} (${savedPct}%)`)

    expect(results).toHaveLength(wallets.length)
    for (const positions of results) {
      expect(Array.isArray(positions)).toBe(true)
    }
  }, 60000)
})
```

Minimum requirement:
- Always create at least `src/integrations/solana/<protocol>/index.test.ts`, even if you only wire it to the shared generic helper in `src/test/solana-integration.ts`
- A richer protocol-specific test file like the example above is preferred when the integration needs extra assertions, batching coverage, or better debugging output
- Add focused assertions for protocol-specific math and output invariants when there is meaningful risk, such as stale valuation handling, APY parsing, share-to-underlying conversion, or metadata shape
- Add a `getUsersFilter` unit test when filters are generated dynamically or easy to regress. For generator filters, assert the first discovery request and then drive the plan with an empty or fixture `AccountsMap`, like `src/integrations/solana/jupiter-lend/index.test.ts`
- Do not skip test creation for a new integration

---

## Step 6 — Local verification

Run these commands to verify before opening a PR:

```bash
# Run the integration's own rich test (requires an RPC URL)
SOLANA_RPC_URL=<url> bun test src/integrations/solana/<protocol>/index.test.ts

# Run via the generic CI harness
SOLANA_RPC_URL=<url> INTEGRATION_NAME=<protocol> INTEGRATION_NETWORK=solana bun test src/test/run-integration.test.ts

# Type-check everything
bun run typecheck
```

All three must succeed before opening a PR. If you don't have a private RPC URL, ask the maintainers — `SOLANA_RPC_URL` is also set as a repository secret for CI.

---

## Step 7 — What CI does automatically (no changes needed)

Once a PR is opened that touches `src/integrations/solana/<protocol>/`:

1. **`detect` job** — diffs changed files and extracts the first integration from `src/integrations/<network>/<name>/`
2. **`test-local`** — runs `bun test src/integrations/solana/<name>/index.test.ts` when that file exists
3. **`test-generic`** — runs `INTEGRATION_NETWORK=solana INTEGRATION_NAME=<name> bun test src/test/run-integration.test.ts`
4. Jobs 2 and 3 run concurrently after `detect` completes
5. Each job posts/updates a collapsible comment on the PR using separate markers — they don't overwrite each other
6. `SOLANA_RPC_URL` must exist as a repo secret — confirm with maintainers if CI fails with an auth error
7. Keep one integration per PR when possible, because CI detects the first changed integration path

Do **not** modify `.github/workflows/ci.yml`.

---

## Step 8 — PR checklist

Before submitting, verify:

- [ ] `src/platforms/<protocol>.ts` created with correct `id`, `name`, `networks: ['solana']`
- [ ] `<protocol>Platform` imported and added to `platforms` array in `src/platforms/index.ts`
- [ ] `src/integrations/solana/<protocol>/index.ts` created
- [ ] `export const testAddress` in `index.ts` points to a wallet with real, live positions
- [ ] `export const PROGRAM_IDS` is present and non-empty
- [ ] `export default <protocol>Integration` present in `index.ts`
- [ ] `platformId` in integration object matches the registered platform `id` exactly
- [ ] User has been asked whether active-user filters need additional on-chain discovery reads
- [ ] `getUsersFilter` is implemented as static `UsersFilter[]` or generator `UsersFilterPlan`, depending on the protocol's active-user discovery needs
- [ ] `src/integrations/solana/<protocol>/index.test.ts` exists
- [ ] `bun run typecheck` passes with no errors
- [ ] `bun test src/test/solana-program-ids.test.ts` passes
- [ ] `SOLANA_RPC_URL=<url> bun test src/integrations/solana/<protocol>/index.test.ts` passes locally
- [ ] `SOLANA_RPC_URL=<url> INTEGRATION_NAME=<protocol> INTEGRATION_NETWORK=solana bun test src/test/run-integration.test.ts` passes locally
- [ ] PR opened against `main`
