import { describe, expect, it } from 'bun:test'
import { testIntegration } from '../../../test/solana-integration'
import { type ProgramRequest, TokenPlugin } from '../../../types/index'
import { divvyIntegration, testAddress } from '.'

function isProgramRequestArray(value: unknown): value is ProgramRequest[] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'kind' in entry &&
      !('platformId' in entry),
  )
}

describe('divvy integration internals', () => {
  it('uses memcmp and dataSize for house discovery requests', async () => {
    const plan = divvyIntegration.getUserPositions?.(testAddress, {
      endpoint: '',
      tokens: new TokenPlugin(),
    })

    if (!plan) {
      throw new Error('divvyIntegration.getUserPositions is not defined')
    }

    const first = await plan.next()
    expect(first.done).toBe(false)
    if (!isProgramRequestArray(first.value)) {
      throw new Error('Expected program requests, received address list')
    }

    const requests = first.value
    expect(requests.length).toBeGreaterThanOrEqual(2)

    const houseRequests = requests.filter(
      (request) =>
        request.kind === 'getProgramAccounts' &&
        request.programId === 'dvyFwAPniptQNb1ey4eM12L8iLHrzdiDsPPDndd6xAR' &&
        request.filters.some(
          (f) =>
            'memcmp' in f &&
            f.memcmp.offset === 0 &&
            f.memcmp.bytes === '4cEdzVs6LUe',
        ),
    )
    expect(houseRequests.length).toBeGreaterThanOrEqual(2)

    const seenSizes = new Set<number>()
    for (const request of houseRequests) {
      expect(request.kind).toBe('getProgramAccounts')
      if (request.kind !== 'getProgramAccounts') {
        throw new Error(`Unexpected request kind: ${request.kind}`)
      }

      const hasMemcmp = request.filters.some(
        (f) => 'memcmp' in f && f.memcmp.offset === 0,
      )
      expect(hasMemcmp).toBe(true)

      const sizeFilter = request.filters.find(
        (f): f is { dataSize: number } => 'dataSize' in f,
      )
      expect(sizeFilter).toBeDefined()
      if (sizeFilter) seenSizes.add(sizeFilter.dataSize)
    }

    expect(seenSizes).toEqual(new Set([294, 312]))
  })
})

testIntegration(divvyIntegration, testAddress, {
  timeoutMs: 180_000,
})
