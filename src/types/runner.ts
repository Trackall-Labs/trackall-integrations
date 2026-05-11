import type { UserDefiPosition } from './position'
import type {
  AccountsMap,
  ProgramRequest,
  SolanaAddress,
  UserPositionsPlan,
} from './solanaIntegration'

/**
 * Drives multiple UserPositionsPlan generators in parallel.
 *
 * Each round, all active generators yield their required addresses or program
 * account requests. Address yields are deduplicated and fetched in a single
 * getMultipleAccounts call shared across all generators. getProgramAccounts
 * requests are fetched in parallel but each result is returned only to the
 * generator that issued the request — results are never cross-pollinated.
 */
export async function runIntegrations(
  plans: UserPositionsPlan[],
  fetchAccounts: (addresses: SolanaAddress[]) => Promise<AccountsMap>,
  fetchProgramAccounts: (req: ProgramRequest) => Promise<AccountsMap>,
): Promise<UserDefiPosition[][]> {
  const steps = await Promise.all(plans.map((p) => p.next()))

  while (steps.some((s) => !s.done)) {
    const addressSet = new Set<SolanaAddress>()
    // Map from generator index to its array of getProgramAccounts requests
    const progReqsByIndex = new Map<number, ProgramRequest[]>()

    for (const [i, step] of steps.entries()) {
      if (step.done) continue
      const val = step.value
      if (Array.isArray(val)) {
        if (val.length === 0) continue
        if (typeof val[0] === 'string') {
          for (const addr of val as SolanaAddress[]) addressSet.add(addr)
        } else {
          progReqsByIndex.set(i, val as ProgramRequest[])
        }
      } else {
        progReqsByIndex.set(i, [val])
      }
    }

    // Flatten all program requests with their generator index for parallel fetch
    const flatProgReqs: { genIndex: number; req: ProgramRequest }[] = []
    for (const [idx, reqs] of progReqsByIndex) {
      for (const req of reqs) flatProgReqs.push({ genIndex: idx, req })
    }

    // Fire address fetch and all program account fetches in parallel
    const [multiMap, ...progMaps] = await Promise.all([
      addressSet.size > 0
        ? fetchAccounts([...addressSet])
        : Promise.resolve<AccountsMap>({}),
      ...flatProgReqs.map(({ req }) => fetchProgramAccounts(req)),
    ])

    await Promise.all(
      plans.map(async (plan, i) => {
        const step = steps[i]
        if (!step || step.done) return
        // Merge all program account results belonging to this generator
        const accounts: AccountsMap = { ...multiMap }
        for (let j = 0; j < flatProgReqs.length; j++) {
          if (flatProgReqs[j]?.genIndex === i)
            Object.assign(accounts, progMaps[j])
        }
        steps[i] = await plan.next(accounts)
      }),
    )
  }

  return steps.map((s) => s.value as UserDefiPosition[])
}
