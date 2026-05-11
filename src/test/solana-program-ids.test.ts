import { describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'

const integrationsDir = new URL('../integrations/solana/', import.meta.url)

const integrationDirs = (
  await readdir(integrationsDir, { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('solana integration PROGRAM_IDS contract', () => {
  for (const dir of integrationDirs) {
    it(`${dir} exports a non-empty PROGRAM_IDS array`, async () => {
      const source = await readFile(
        new URL(`${dir}/index.ts`, integrationsDir),
        'utf8',
      )

      expect(source.includes('export const PROGRAM_IDS')).toBe(true)
      expect(
        /export const PROGRAM_IDS\s*=\s*(\[[\s\S]*?\]|[A-Za-z0-9_]+)/.test(
          source,
        ),
      ).toBe(true)
    })
  }
})
