# @trackall/integrations

DeFi position integrations for Trackall. The package currently contains:

- Solana integrations under `src/integrations/solana/*`
- Movement integrations under `src/integrations/movement/*`, using the Aptos SDK integration shape
- Shared platform metadata in `src/platforms/*`
- Shared token plugins and test harnesses in `src/plugin/*` and `src/test/*`

The package entrypoint currently auto-discovers and exports Solana integrations. Movement integrations are implemented and tested in-repo, but are not auto-exported from the package root.

## Shared Position Kinds

Integrations return `UserDefiPosition[]` built from the shared types in `src/types/position.ts`.

Current top-level `positionKind` values:

- `lending` for supplied and borrowed credit positions
- `staking` for assets actively staked or in unbonding
- `liquidity` for AMM or concentrated-liquidity pool positions
- `vesting` for locked token allocations that unlock over time
- `reward` for standalone claimable distributions such as airdrops or unclaimed incentives

Modeling rules:

- Use the dedicated top-level kind when the position itself is fundamentally lending, staking, liquidity, vesting, or reward-based.
- Use the shared `rewards` field on a non-reward position only for incentives attached to that primary position.
- Use `reward` when the claimable asset stands alone and is not naturally attached to a lending, staking, liquidity, or vesting position.

### Position Metadata

All shared position types extend `BaseDefiPosition`, which supports optional integration-specific metadata:

```ts
type PositionMetadata = Record<string, Record<string, unknown>>
```

Use `meta` only for structured protocol-specific details that do not fit an existing shared field. Prefer canonical shared fields such as `positionKind`, `rewards`, `usdValue`, token amounts, and timestamps whenever the concept already has a dedicated place in the schema.

Keep metadata keys stable and semantic so downstream consumers can rely on them. Prefer domain nouns like `subaccount`, `vault`, or `lock`, with an object payload under each key.

Example:

```ts
meta: {
  subaccount: {
    name: 'Hedge',
  },
}
```

## Repository Layout

```text
src/
  integrations/
    solana/<integration-name>/
      index.ts
      index.test.ts
    movement/<integration-name>/
      index.ts
      index.test.ts
  platforms/
    <integration-name>.ts
    index.ts
  plugin/
    solana/
    aptos/
  test/
    solana-integration.ts
    aptos-integration.ts
    run-integration.test.ts
```

## Adding a New Integration

### 1. Create platform metadata

Add `src/platforms/<integration-name>.ts` with the `Platform` shape:

```ts
import type { Platform } from '../types/platform'

const myPlatform = {
  id: 'my-platform' as const,
  networks: ['movement'],
  name: 'My Platform',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://example.com/logo.png',
  description: 'Short description',
  tags: ['lending'],
  defiLlamaId: 'my-platform',
  links: {
    website: 'https://example.com',
    documentation: 'https://docs.example.com',
  },
} satisfies Platform

export default myPlatform
```

Register it in `src/platforms/index.ts` so its `id` becomes part of the `PlatformId` union.

### 2. Create the integration directory

Pick the network-specific path:

- Solana: `src/integrations/solana/<integration-name>/`
- Movement: `src/integrations/movement/<integration-name>/`

Each integration should have:

- `index.ts` for the integration implementation
- `index.test.ts` for the network-specific test entrypoint when local integration tests are needed

Export `testAddress` from `index.ts` whenever the generic test runner should exercise `getUserPositions`.

### 3. Implement the network-specific integration

#### Solana

Implement `SolanaIntegration` from `src/types/solanaIntegration.ts`.

```ts
import type { SolanaIntegration } from '../../../types/solanaIntegration'

export const testAddress = 'WalletAddressWithPositions'

const integration: SolanaIntegration = {
  platformId: 'my-platform',
  getUserPositions(address, plugins) {
    return (async function* () {
      const accounts = yield ['AccountPubkey1', 'AccountPubkey2']

      const programAccounts = yield {
        kind: 'getProgramAccounts' as const,
        programId: 'ProgramId',
        filters: [],
      }

      return []
    })()
  },
}

export default integration
```

Solana integrations use the async-generator batching protocol:

- `yield string[]` to request specific accounts
- `yield { kind: 'getProgramAccounts', ... }` to request program-owned accounts
- `yield { kind: 'getTokenAccountsByOwner', ... }` when token-account discovery is needed
- `return UserDefiPosition[]` when the plan is complete

Use `runIntegrations`, `fetchAccountsBatch`, and `fetchProgramAccountsBatch` for tests and local execution. Do not make direct RPC calls inside the integration when the same data can be requested through yielded batch operations.

Every Solana integration must export a top-level `PROGRAM_IDS` constant from the module. Do not put `indexedPrograms` on the `SolanaIntegration` object; the package root aggregates exported `PROGRAM_IDS` constants automatically, and CI treats missing or invalid `PROGRAM_IDS` as a failure.

When building positions, prefer the shared types from `src/types/position.ts`:

- `LendingDefiPosition`
- `StakingDefiPosition`
- `LiquidityDefiPosition`
- `VestingDefiPosition`
- `RewardDefiPosition`

Use `meta` for extra structured protocol details that are useful to consumers but do not belong in the shared schema, for example `meta.subaccount.name` for Drift subaccounts.

#### Movement / Aptos-style

Implement `AptosIntegration` from `src/types/aptosIntegration.ts`.

```ts
import type {
  AptosIntegration,
  AptosPlugins,
} from '../../../types/aptosIntegration'
import type { UserDefiPosition } from '../../../types/position'

export const testAddress = '0xwallet_with_known_positions'

async function getUserPositions(
  address: string,
  { client, tokens }: AptosPlugins,
): Promise<UserDefiPosition[]> {
  const token = await tokens.fetch('0x1::aptos_coin::AptosCoin')
  void address
  void client
  void token
  return []
}

export const myIntegration: AptosIntegration = {
  platformId: 'my-platform',
  getUserPositions,
}

export default myIntegration
```

Movement integrations in this repo currently use:

- `AptosPlugins` with `client` and `AptosTokenPlugin`
- direct async calls rather than the Solana generator protocol
- `testAptosIntegration` from `src/test/aptos-integration.ts` for shared test coverage

Use `src/integrations/movement/yuzu/index.ts` as the canonical example.

Use the same shared position taxonomy here:

- emit `vesting` for token unlock schedules
- emit `reward` for standalone claimable airdrops or incentive balances
- keep nested `rewards` for incentives attached to another primary position
- use `meta` for structured protocol-specific details that do not fit shared fields, for example `meta.subaccount.name`

### 4. Add a local test entrypoint

#### Solana local test shape

Create `src/integrations/solana/<integration-name>/index.test.ts` and wire it through the shared Solana harness:

```ts
import { testIntegration } from '../../../test/solana-integration'
import { myIntegration, testAddress } from '.'

testIntegration(myIntegration, testAddress)
```

For richer Solana-specific batching assertions, expand the test like `src/integrations/solana/meteora/index.test.ts`.

#### Movement local test shape

Create `src/integrations/movement/<integration-name>/index.test.ts`:

```ts
import { testAptosIntegration } from '../../../test/aptos-integration'
import { myIntegration, testAddress } from '.'

testAptosIntegration(myIntegration, testAddress)
```

### 5. Verify locally

Install dependencies:

```sh
bun install
```

Type-check:

```sh
bun run typecheck
```

Run a Solana integration test:

```sh
SOLANA_RPC_URL=https://... bun test src/integrations/solana/meteora/index.test.ts
```

Run a Movement integration test:

```sh
MOVEMENT_RPC_URL=https://mainnet.movementnetwork.xyz/v1 \
MOVEMENT_INDEXER_URL=https://indexer.mainnet.movementnetwork.xyz/v1/graphql \
bun test src/integrations/movement/yuzu/index.test.ts
```

Run the generic integration test:

```sh
INTEGRATION_NAME=yuzu \
INTEGRATION_NETWORK=movement \
MOVEMENT_RPC_URL=https://mainnet.movementnetwork.xyz/v1 \
MOVEMENT_INDEXER_URL=https://indexer.mainnet.movementnetwork.xyz/v1/graphql \
bun test src/test/run-integration.test.ts
```

If `INTEGRATION_NETWORK` is omitted, the generic runner will try to infer it by scanning `src/integrations/*`.

## CI And PR Workflow

CI is defined in `.github/workflows/ci.yml`.

Current behavior:

1. CI installs dependencies and runs `bun run typecheck`.
2. It scans `git diff` for the first changed path matching `src/integrations/<network>/<name>/...`.
3. If `src/integrations/<network>/<name>/index.test.ts` exists, CI runs that file as the local integration test.
4. CI also runs `src/test/run-integration.test.ts` with `INTEGRATION_NAME=<name>` and `INTEGRATION_NETWORK=<network>`.
5. For Movement integrations, CI passes `MOVEMENT_RPC_URL` and `MOVEMENT_INDEXER_URL`.
6. For Solana integrations, CI passes `SOLANA_RPC_URL`.

Practical implications:

- Keep one integration per PR when possible, because CI detects the first changed integration path.
- Export `testAddress` when `getUserPositions` should be exercised by the shared test harness.
- Put local integration tests at `src/integrations/<network>/<name>/index.test.ts`.

## Linting And Formatting

This package uses [Biome](https://biomejs.dev).

```sh
# Check formatting and lint rules
bun run lint

# Auto-format files
bun run format
```

## Key Files

| Purpose | File |
|---|---|
| Solana integration interface | `src/types/solanaIntegration.ts` |
| Aptos/Movement integration interface | `src/types/aptosIntegration.ts` |
| Shared platform registry | `src/platforms/index.ts` |
| Solana token plugin | `src/plugin/solana/tokens.ts` |
| Aptos token plugin | `src/plugin/aptos/tokens.ts` |
| Solana shared test harness | `src/test/solana-integration.ts` |
| Aptos shared test harness | `src/test/aptos-integration.ts` |
| Generic integration runner | `src/test/run-integration.test.ts` |
