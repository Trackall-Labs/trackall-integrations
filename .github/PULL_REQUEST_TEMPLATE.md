## Integration name

<!-- e.g. Orca, Drift -->

## Description

<!-- One paragraph describing what this integration does or what changed. -->

## Pre-flight checklist

- [ ] One integration per PR (CI detects only the first changed `src/integrations/<network>/<name>/`)
- [ ] `src/integrations/<network>/<name>/index.test.ts` exists with a valid `testAddress`
- [ ] `src/platforms/<name>.ts` created and registered in `src/platforms/index.ts`
- [ ] Typecheck passes locally: `bun run typecheck`
- [ ] Lint passes locally: `bun run lint`
- [ ] Integration tests pass locally: `SOLANA_RPC_URL=<url> bun test src/integrations/<network>/<name>/index.test.ts`

## Notes for reviewer (optional)

<!-- Anything the reviewer should know: quirks, assumptions, missing features, etc. -->
