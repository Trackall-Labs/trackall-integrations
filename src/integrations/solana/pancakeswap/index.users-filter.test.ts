import { describe, expect, it } from 'bun:test'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import type { AccountsMap, UsersFilterPlan } from '../../../types/index'
import clmmIdl from '../raydium/idls/amm_v3.json'
import { PROGRAM_IDS, pancakeswapIntegration } from './index'

const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const ONE_HOUR_IN_MS = 60 * 60 * 1000
const PERSONAL_POSITION_NFT_MINT_OFFSET = 9
const PANCAKESWAP_CLMM_PROGRAM_ID = PROGRAM_IDS[0]

const PERSONAL_POSITION_DISC = Buffer.from(
  clmmIdl.accounts.find((account) => account.name === 'PersonalPositionState')
    ?.discriminator ?? [],
)
const PERSONAL_POSITION_DISC_B64 = PERSONAL_POSITION_DISC.toString('base64')

const { getUsersFilter } = pancakeswapIntegration
if (!getUsersFilter) throw new Error('getUsersFilter not implemented')

function buildPersonalPositionData(nftMint: string): Uint8Array {
  const buf = Buffer.alloc(PERSONAL_POSITION_NFT_MINT_OFFSET + 32)
  PERSONAL_POSITION_DISC.copy(buf, 0)
  buf[8] = 1
  new PublicKey(nftMint).toBuffer().copy(buf, PERSONAL_POSITION_NFT_MINT_OFFSET)
  return new Uint8Array(buf)
}

describe('pancakeswap getUsersFilter', () => {
  it('starts users filter discovery from CLMM personal position accounts', async () => {
    const plan = getUsersFilter() as UsersFilterPlan

    const first = await plan.next()
    if (first.done) throw new Error('Expected discovery request')
    if (Array.isArray(first.value)) {
      throw new Error('Expected a single discovery request')
    }
    if (first.value.kind !== 'getProgramAccounts') {
      throw new Error('Expected getProgramAccounts request')
    }

    expect(first.value.kind).toBe('getProgramAccounts')
    expect(first.value.programId).toBe(PANCAKESWAP_CLMM_PROGRAM_ID)
    expect(first.value.cacheTtlMs).toBe(ONE_HOUR_IN_MS)
    expect(first.value.filters).toEqual([
      {
        memcmp: {
          offset: 0,
          bytes: PERSONAL_POSITION_DISC_B64,
          encoding: 'base64',
        },
      },
    ])

    const done = await plan.next({})
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')
    expect(Array.from(done.value)).toEqual([])
  })

  it('builds SPL and Token-2022 holder filters for discovered position NFT mints', async () => {
    const mintA = 'So11111111111111111111111111111111111111112'
    const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

    const plan = getUsersFilter() as UsersFilterPlan
    await plan.next()

    const wrongDisc = Buffer.from(buildPersonalPositionData(mintA))
    wrongDisc[0] = wrongDisc[0] === 0 ? 1 : 0

    const discoveryMap: AccountsMap = {
      validA: {
        exists: true,
        address: 'validA',
        lamports: 1n,
        programAddress: PANCAKESWAP_CLMM_PROGRAM_ID ?? '',
        data: buildPersonalPositionData(mintA),
      },
      validADuplicate: {
        exists: true,
        address: 'validADuplicate',
        lamports: 1n,
        programAddress: PANCAKESWAP_CLMM_PROGRAM_ID ?? '',
        data: buildPersonalPositionData(mintA),
      },
      validB: {
        exists: true,
        address: 'validB',
        lamports: 1n,
        programAddress: PANCAKESWAP_CLMM_PROGRAM_ID ?? '',
        data: buildPersonalPositionData(mintB),
      },
      wrongProgram: {
        exists: true,
        address: 'wrongProgram',
        lamports: 1n,
        programAddress: TOKEN_PROGRAM_ID.toBase58(),
        data: buildPersonalPositionData(mintA),
      },
      shortData: {
        exists: true,
        address: 'shortData',
        lamports: 1n,
        programAddress: PANCAKESWAP_CLMM_PROGRAM_ID ?? '',
        data: new Uint8Array(PERSONAL_POSITION_NFT_MINT_OFFSET + 31),
      },
      wrongDiscriminator: {
        exists: true,
        address: 'wrongDiscriminator',
        lamports: 1n,
        programAddress: PANCAKESWAP_CLMM_PROGRAM_ID ?? '',
        data: new Uint8Array(wrongDisc),
      },
      missingAccount: {
        exists: false,
        address: 'missingAccount',
      },
    }

    const done = await plan.next(discoveryMap)
    if (!done.done) throw new Error('Expected users filter plan to finish')

    const filters = done.value
    expect(filters).toHaveLength(4)
    expect(
      filters.every(
        (filter) => filter.ownerOffset === TOKEN_ACCOUNT_OWNER_OFFSET,
      ),
    ).toBe(true)
    expect(
      filters.every(
        (filter) =>
          filter.memcmps?.length === 1 &&
          filter.memcmps[0]?.offset === TOKEN_ACCOUNT_MINT_OFFSET,
      ),
    ).toBe(true)

    const pairs = new Set(
      filters.map((filter) => {
        const mintBytes = filter.memcmps?.[0]?.bytes
        if (!mintBytes) throw new Error('Expected mint memcmp bytes')
        return `${filter.programId}:${new PublicKey(mintBytes).toBase58()}`
      }),
    )

    expect(pairs).toEqual(
      new Set([
        `${TOKEN_PROGRAM_ID.toBase58()}:${mintA}`,
        `${TOKEN_2022_PROGRAM_ID.toBase58()}:${mintA}`,
        `${TOKEN_PROGRAM_ID.toBase58()}:${mintB}`,
        `${TOKEN_2022_PROGRAM_ID.toBase58()}:${mintB}`,
      ]),
    )
  })
})
