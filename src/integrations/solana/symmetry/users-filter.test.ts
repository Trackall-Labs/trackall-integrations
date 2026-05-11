import { describe, expect, it } from 'bun:test'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type { UsersFilterPlan } from '../../../types/index'
import {
  buildTokenHolderUsersFiltersByMints,
  symmetryIntegration,
} from './index'

const SYMMETRY_VAULTS_V3_PROGRAM_ID =
  'BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate'
const VAULT_PDA_SEED = Buffer.from('basket')
const LEGACY_YSOL_MINT = '3htQDAvEx53jyMJ2FVHeztM5BRjfmNuBqceXu1fJRqWx'

const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const VAULT_DISCRIMINATOR_BYTES = 8
const VAULT_VERSION_OFFSET = 0
const VAULT_MINT_OFFSET = 33
const VAULT_SUPPLY_OUTSTANDING_OFFSET = 65
const VAULT_NUM_TOKENS_OFFSET = 1750
const VAULT_COMPOSITION_OFFSET = 1751

const getUsersFilter = symmetryIntegration.getUsersFilter
if (!getUsersFilter) throw new Error('getUsersFilter not implemented')

function buildVaultAccountData(
  mint: string,
  supplyOutstandingRaw: bigint,
): Uint8Array {
  const data = Buffer.alloc(VAULT_COMPOSITION_OFFSET)
  data[VAULT_VERSION_OFFSET] = 3
  new PublicKey(mint).toBuffer().copy(data, VAULT_MINT_OFFSET)
  data.writeBigUInt64LE(supplyOutstandingRaw, VAULT_SUPPLY_OUTSTANDING_OFFSET)
  data[VAULT_NUM_TOKENS_OFFSET] = 0

  return Uint8Array.from(
    Buffer.concat([Buffer.alloc(VAULT_DISCRIMINATOR_BYTES), data]),
  )
}

function deriveVaultAddress(mint: string): string {
  const [vaultAddress] = PublicKey.findProgramAddressSync(
    [VAULT_PDA_SEED, new PublicKey(mint).toBuffer()],
    new PublicKey(SYMMETRY_VAULTS_V3_PROGRAM_ID),
  )
  return vaultAddress.toBase58()
}

describe('symmetry getUsersFilter', () => {
  it('starts users filter discovery from symmetry vault accounts', async () => {
    const plan = getUsersFilter() as UsersFilterPlan

    const first = await plan.next()
    if (first.done) throw new Error('Expected discovery request')
    if (Array.isArray(first.value)) {
      throw new Error('Expected a single discovery request')
    }
    if (first.value.kind !== 'getProgramAccounts') {
      throw new Error('Expected getProgramAccounts discovery request')
    }

    expect(first.value.programId).toBe(SYMMETRY_VAULTS_V3_PROGRAM_ID)
    expect(first.value.filters).toEqual([])

    await plan.return([])
  })

  it('returns legacy token-holder filters when discovery has no accounts', async () => {
    const plan = getUsersFilter() as UsersFilterPlan
    await plan.next()
    const done = await plan.next({})

    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')

    expect(done.value).toHaveLength(1)
    expect(done.value[0]?.programId).toBe(TOKEN_PROGRAM_ID.toBase58())
    expect(done.value[0]?.ownerOffset).toBe(TOKEN_ACCOUNT_OWNER_OFFSET)

    const memcmp = done.value[0]?.memcmps?.[0]
    if (!memcmp) throw new Error('Expected mint memcmp')
    expect(memcmp.offset).toBe(TOKEN_ACCOUNT_MINT_OFFSET)
    expect(new PublicKey(memcmp.bytes).toBase58()).toBe(LEGACY_YSOL_MINT)
  })

  it('adds discovered vault mints to users filters', async () => {
    const discoveredMint = 'So11111111111111111111111111111111111111112'
    const discoveredVaultAddress = deriveVaultAddress(discoveredMint)
    const discoveredVaultData = buildVaultAccountData(discoveredMint, 1n)

    const plan = getUsersFilter() as UsersFilterPlan
    await plan.next()
    const done = await plan.next({
      [discoveredVaultAddress]: {
        exists: true,
        address: discoveredVaultAddress,
        lamports: 1n,
        programAddress: SYMMETRY_VAULTS_V3_PROGRAM_ID,
        data: discoveredVaultData,
      },
    })

    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')

    const returnedMints = new Set(
      done.value.map((filter) => {
        const memcmp = filter.memcmps?.[0]
        if (!memcmp) throw new Error('Expected mint memcmp')
        return new PublicKey(memcmp.bytes).toBase58()
      }),
    )

    expect(returnedMints).toEqual(new Set([LEGACY_YSOL_MINT, discoveredMint]))
  })

  it('builds deduplicated holder filters and ignores invalid mints', () => {
    const mintA = 'So11111111111111111111111111111111111111112'
    const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

    const filters = buildTokenHolderUsersFiltersByMints([
      mintA,
      'not-a-valid-pubkey',
      mintA,
      mintB,
    ])

    expect(filters).toHaveLength(2)

    const returnedMints = new Set(
      filters.map((filter) => {
        const memcmp = filter.memcmps?.[0]
        if (!memcmp) throw new Error('Expected mint memcmp')
        return new PublicKey(memcmp.bytes).toBase58()
      }),
    )

    expect(returnedMints).toEqual(new Set([mintA, mintB]))
  })
})
