---
name: aptos
description: Scaffold and implement a new Movement integration in this repo using the Aptos SDK pattern, platform metadata, shared test harness, and repo CI flow
---

You are helping the user add a new Movement integration to the `packages/integrations` workspace. In this repo, Movement integrations use the Aptos SDK integration shape. Follow the steps below in order. Ask for the protocol name before starting if it has not been provided.

---

## Step 1 - Gather required information

Ask the user for:

1. `protocol` - lowercase, no spaces, used in paths like `src/integrations/movement/<protocol>/`
2. `testAddress` - a Movement wallet address known to hold live positions for the protocol
3. Platform metadata:
   - `name`
   - `image` URL
   - `description`
   - optional `defiLlamaId`
   - optional `tags`
   - optional `links`

If any of these are missing, ask before proceeding.

---

## Step 2 - Create platform metadata

Create `src/platforms/<protocol>.ts` modeled on `src/platforms/yuzu.ts`:

```ts
import type { Platform } from '../types/platform'

const <protocol>Platform = {
  id: '<protocol>' as const,
  networks: ['movement'],
  name: '<Name>',
  image: '<image-url>',
  description: '<Short description>',
  tags: ['lending'],
  defiLlamaId: '<defiLlamaId>',
  links: {
    website: 'https://example.com',
  },
} satisfies Platform

export default <protocol>Platform
```

Rules:

- `id` must be unique and must exactly match the integration `platformId`
- `networks` must include `'movement'`
- `tags` must be valid `PlatformTag` string values such as `'lending'`
- omit optional fields instead of filling them with placeholders if the real value is unknown

---

## Step 3 - Register the platform

Update `src/platforms/index.ts`:

```ts
import <protocol>Platform from './<protocol>'

export const platforms = [
  meteoraPlatform,
  jupiterLendPlatform,
  kaminoPlatform,
  raydiumPlatform,
  yuzuPlatform,
  <protocol>Platform,
] as const satisfies readonly Platform[]
```

Read the file first and preserve the existing style and ordering conventions already used in the repo.

---

## Step 4 - Create the integration file

Create `src/integrations/movement/<protocol>/index.ts`.

Use `src/integrations/movement/yuzu/index.ts` as the canonical reference and implement `AptosIntegration` from `src/types/aptosIntegration.ts`.

Required shape:

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
  void address
  void client
  void tokens

  return []
}

export const <protocol>Integration: AptosIntegration = {
  platformId: '<protocol>',
  getUserPositions,
}

export default <protocol>Integration
```

Rules:

- `export default` is required
- `export const testAddress` is expected when the shared test harness should run `getUserPositions`
- `platformId` must exactly match the registered platform id
- use `AptosPlugins` instead of creating your own client or token-plugin shape
- use `AptosTokenPlugin` via `plugins.tokens` for token metadata lookups
- keep the implementation promise-based; do not use the Solana generator protocol here

When implementing protocol logic:

- prefer existing on-chain views or resource reads exposed through the Aptos SDK client
- normalize addresses when the protocol can return mixed padded and non-padded forms
- return `UserDefiPosition[]` using the shared position types from `src/types/`
- keep repo-specific conventions aligned with `yuzu`
- use `VestingDefiPosition` for token unlock schedules and `RewardDefiPosition` for standalone claimable rewards or airdrops
- keep nested `rewards` for incentives attached to a primary lending, staking, liquidity, or vesting position
- use `meta?: PositionMetadata` for structured protocol-specific details that do not fit shared fields; `PositionMetadata` is `Record<string, Record<string, unknown>>`, for example `meta.subaccount.name`

---

## Step 5 - Create the test file

Create `src/integrations/movement/<protocol>/index.test.ts`:

```ts
import { testAptosIntegration } from '../../../test/aptos-integration'
import { <protocol>Integration, testAddress } from '.'

testAptosIntegration(<protocol>Integration, testAddress)
```

This shared harness will:

- create the Aptos client with `MOVEMENT_RPC_URL`
- attach the indexer using `MOVEMENT_INDEXER_URL`
- construct `AptosTokenPlugin`
- run `getUserPositions`, `getTvl`, `getVolume`, and `getDailyActiveUsers` when present

Do not add extra tests unless the user asks for them.

---

## Step 6 - Local verification

Run these commands before opening a PR:

```sh
MOVEMENT_RPC_URL=https://mainnet.movementnetwork.xyz/v1 \
MOVEMENT_INDEXER_URL=https://indexer.mainnet.movementnetwork.xyz/v1/graphql \
bun test src/integrations/movement/<protocol>/index.test.ts
```

```sh
INTEGRATION_NAME=<protocol> \
INTEGRATION_NETWORK=movement \
MOVEMENT_RPC_URL=https://mainnet.movementnetwork.xyz/v1 \
MOVEMENT_INDEXER_URL=https://indexer.mainnet.movementnetwork.xyz/v1/graphql \
bun test src/test/run-integration.test.ts
```

```sh
bun run typecheck
```

If the protocol does not support one of the optional stats methods, leave that method undefined instead of stubbing fake values.

---

## Step 7 - CI behavior in this repo

CI scans changed files for the first path matching `src/integrations/<network>/<name>/...`.

For a Movement integration PR:

- local integration test: `src/integrations/movement/<protocol>/index.test.ts`
- generic integration test: `src/test/run-integration.test.ts`
- required env vars in CI: `MOVEMENT_RPC_URL`, `MOVEMENT_INDEXER_URL`

Keep the PR focused on one integration when possible so CI detection is unambiguous.
