import { readdir } from 'node:fs/promises'
import { testAptosIntegration } from './aptos-integration'
import { testIntegration } from './solana-integration'

const integrationsDir = new URL('../integrations/', import.meta.url)

const name = process.env.INTEGRATION_NAME
if (!name) throw new Error('INTEGRATION_NAME env var is required')

const network =
  process.env.INTEGRATION_NETWORK ?? (await findIntegrationNetwork(name))
const mod = await import(
  new URL(`${network}/${name}/index.ts`, integrationsDir).href
)

if (network === 'solana') {
  testIntegration(mod.default, mod.testAddress)
} else if (network === 'movement' || network === 'aptos') {
  testAptosIntegration(mod.default, mod.testAddress)
} else {
  throw new Error(
    `Unsupported integration network "${network}". Set INTEGRATION_NETWORK explicitly and add a test runner mapping in src/test/run-integration.test.ts.`,
  )
}

async function findIntegrationNetwork(integrationName: string) {
  const matches: string[] = []

  for (const networkEntry of await readdir(integrationsDir, {
    withFileTypes: true,
  })) {
    if (!networkEntry.isDirectory()) continue

    const networkDir = new URL(`${networkEntry.name}/`, integrationsDir)
    const integrationEntries = await readdir(networkDir, {
      withFileTypes: true,
    })

    if (
      integrationEntries.some(
        (entry) => entry.isDirectory() && entry.name === integrationName,
      )
    ) {
      matches.push(networkEntry.name)
    }
  }

  if (matches.length === 1) return matches[0]

  if (matches.length === 0) {
    throw new Error(
      `Integration "${integrationName}" was not found under src/integrations. Set INTEGRATION_NETWORK if the directory was renamed.`,
    )
  }

  throw new Error(
    `Integration "${integrationName}" exists in multiple networks (${matches.join(', ')}). Set INTEGRATION_NETWORK explicitly.`,
  )
}
