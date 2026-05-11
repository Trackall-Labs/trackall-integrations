import { describe, expect, it } from 'bun:test'
import { testIntegration } from '../../../test/solana-integration'
import type {
  AccountsMap,
  GetProgramAccountsRequest,
  ProgramRequest,
  UsersFilter,
  UsersFilterPlan,
} from '../../../types/index'
import { PROGRAM_IDS, realmsIntegration, testAddress } from '.'

const TOKEN_OWNER_RECORD_V1 = 2
const TOKEN_OWNER_RECORD_V2 = 17
const REALM_V1 = 1
const REALM_V2 = 16

function buildRealmAccountData(
  accountType: typeof REALM_V1 | typeof REALM_V2,
  realmName: string,
): Uint8Array {
  const nameBytes = Buffer.from(realmName)
  const data = Buffer.alloc(72 + nameBytes.length)

  data[0] = accountType
  Buffer.alloc(32, 1).copy(data, 1) // community mint
  data[58] = 0 // council mint option: none
  data.writeUInt16LE(0, 65) // voting proposal count
  data[67] = 0 // authority option: none
  data.writeUInt32LE(nameBytes.length, 68)
  nameBytes.copy(data, 72)

  return new Uint8Array(data)
}

function extractDiscoveryPrograms(
  requests: ProgramRequest[],
): Map<string, Set<string>> {
  const byProgram = new Map<string, Set<string>>()
  for (const request of requests) {
    if (request.kind !== 'getProgramAccounts') {
      throw new Error('Expected discovery getProgramAccounts requests')
    }
    const typed = request as GetProgramAccountsRequest
    const discFilter = typed.filters[0]
    if (!discFilter || !('memcmp' in discFilter)) {
      throw new Error('Expected discriminator memcmp filter')
    }

    const perProgram = byProgram.get(typed.programId) ?? new Set<string>()
    perProgram.add(discFilter.memcmp.bytes)
    byProgram.set(typed.programId, perProgram)
  }
  return byProgram
}

function collectFilterDiscriminators(
  filters: UsersFilter[],
): Map<string, Set<number>> {
  const byProgram = new Map<string, Set<number>>()
  for (const filter of filters) {
    const discriminator = filter.discriminator
    if (!discriminator || discriminator.length !== 1) {
      throw new Error('Expected one-byte token owner record discriminator')
    }
    expect(filter.ownerOffset).toBe(65)
    const perProgram = byProgram.get(filter.programId) ?? new Set<number>()
    perProgram.add(discriminator[0] ?? -1)
    byProgram.set(filter.programId, perProgram)
  }
  return byProgram
}

const { getUsersFilter } = realmsIntegration
if (!getUsersFilter) throw new Error('getUsersFilter not implemented')

describe('realms integration', () => {
  it('starts users filter discovery from realms accounts', async () => {
    const plan = getUsersFilter() as UsersFilterPlan

    const first = await plan.next()
    if (first.done) throw new Error('Expected discovery requests')
    if (!Array.isArray(first.value)) {
      throw new Error('Expected discovery request array')
    }

    const requests = first.value as ProgramRequest[]
    expect(requests).toHaveLength(PROGRAM_IDS.length * 2)
    const byProgram = extractDiscoveryPrograms(requests)

    expect(new Set(byProgram.keys())).toEqual(new Set(PROGRAM_IDS))
    for (const programId of PROGRAM_IDS) {
      expect(byProgram.get(programId)).toEqual(
        new Set([
          Buffer.from([REALM_V1]).toString('base64'),
          Buffer.from([REALM_V2]).toString('base64'),
        ]),
      )
    }

    await plan.return([])
  })

  it('scopes users filters to discovered governance programs', async () => {
    const plan = getUsersFilter() as UsersFilterPlan
    await plan.next()

    const selectedPrograms: string[] = [PROGRAM_IDS[1], PROGRAM_IDS[4]]

    const discoveryMap: AccountsMap = Object.fromEntries(
      selectedPrograms.map((programId, index) => [
        `realm-${index}`,
        {
          exists: true as const,
          address: `realm-${index}`,
          lamports: 1n,
          programAddress: programId,
          data: buildRealmAccountData(
            index % 2 === 0 ? REALM_V1 : REALM_V2,
            `realm-${index}`,
          ),
        },
      ]),
    )

    const done = await plan.next(discoveryMap)
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')

    expect(done.value).toHaveLength(selectedPrograms.length * 2)
    const byProgram = collectFilterDiscriminators(done.value)

    expect(new Set(byProgram.keys())).toEqual(new Set(selectedPrograms))
    for (const programId of selectedPrograms) {
      expect(byProgram.get(programId)).toEqual(
        new Set([TOKEN_OWNER_RECORD_V1, TOKEN_OWNER_RECORD_V2]),
      )
    }
  })

  it('falls back to static governance program list when discovery is empty', async () => {
    const plan = getUsersFilter() as UsersFilterPlan
    await plan.next()

    const done = await plan.next({})
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')

    expect(done.value).toHaveLength(PROGRAM_IDS.length * 2)
    const byProgram = collectFilterDiscriminators(done.value)

    expect(new Set(byProgram.keys())).toEqual(new Set(PROGRAM_IDS))
    for (const programId of PROGRAM_IDS) {
      expect(byProgram.get(programId)).toEqual(
        new Set([TOKEN_OWNER_RECORD_V1, TOKEN_OWNER_RECORD_V2]),
      )
    }
  })
})

testIntegration(realmsIntegration, testAddress, {
  timeoutMs: 180_000,
})
