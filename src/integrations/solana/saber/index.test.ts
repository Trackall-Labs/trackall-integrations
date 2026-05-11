import { describe, expect, it } from 'bun:test'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import type { AccountsMap, UsersFilterPlan } from '../../../types/index'
import { PROGRAM_IDS, saberIntegration, testAddress } from '.'

const { getUsersFilter } = saberIntegration
if (!getUsersFilter) throw new Error('getUsersFilter not implemented')

const SABER_SWAP_PROGRAM_ID = PROGRAM_IDS[0]
const SWAP_ACCOUNT_SIZE = 395
const TOKEN_ACCOUNT_MINT_OFFSET = 0
const TOKEN_ACCOUNT_OWNER_OFFSET = 32
const SWAP_TOKEN_A_RESERVE_OFFSET = 107
const SWAP_TOKEN_B_RESERVE_OFFSET = 139
const SWAP_POOL_MINT_OFFSET = 171
const SWAP_TOKEN_A_MINT_OFFSET = 203
const SWAP_TOKEN_B_MINT_OFFSET = 235

function writePubkey(buf: Buffer, offset: number, value: string): void {
  Buffer.from(new PublicKey(value).toBytes()).copy(buf, offset)
}

function buildSwapAccountData(input: {
  tokenAReserve: string
  tokenBReserve: string
  poolMint: string
  tokenAMint: string
  tokenBMint: string
  isInitialized?: boolean
}): Uint8Array {
  const buf = Buffer.alloc(SWAP_ACCOUNT_SIZE, 0)
  buf[0] = input.isInitialized === false ? 0 : 1
  writePubkey(buf, SWAP_TOKEN_A_RESERVE_OFFSET, input.tokenAReserve)
  writePubkey(buf, SWAP_TOKEN_B_RESERVE_OFFSET, input.tokenBReserve)
  writePubkey(buf, SWAP_POOL_MINT_OFFSET, input.poolMint)
  writePubkey(buf, SWAP_TOKEN_A_MINT_OFFSET, input.tokenAMint)
  writePubkey(buf, SWAP_TOKEN_B_MINT_OFFSET, input.tokenBMint)
  return new Uint8Array(buf)
}

describe('saber users filter', () => {
  it('starts users filter discovery from saber swap accounts', async () => {
    const plan = getUsersFilter() as UsersFilterPlan

    const first = await plan.next()
    if (first.done) throw new Error('Expected discovery request')
    if (Array.isArray(first.value)) {
      throw new Error('Expected a single discovery request')
    }
    if (first.value.kind !== 'getProgramAccounts') {
      throw new Error('Expected getProgramAccounts request')
    }

    expect(first.value.programId).toBe(SABER_SWAP_PROGRAM_ID)
    expect(first.value.filters).toEqual([{ dataSize: SWAP_ACCOUNT_SIZE }])

    const done = await plan.next({})
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')
    expect(done.value).toEqual([])
  })

  it('returns holder filters for discovered LP mints on both token programs', async () => {
    const lpMintA = 'So11111111111111111111111111111111111111112'
    const lpMintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const reserveA = 'Es9vMFrzaCERmJfrF4H2rRjB9A8RduCMsZbxXXCtK5v'
    const reserveB = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
    const tokenAMint = '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'
    const tokenBMint = 'mSoLzYCxHdYgdzU2oHvu9y5Q6z3Pj9s2xQ3ZKQx4vM1'

    const plan = getUsersFilter() as UsersFilterPlan
    const first = await plan.next()
    if (first.done) throw new Error('Expected discovery request')

    const discoveryResult: AccountsMap = {
      poolA: {
        exists: true,
        address: 'poolA',
        lamports: 0n,
        programAddress: SABER_SWAP_PROGRAM_ID,
        data: buildSwapAccountData({
          tokenAReserve: reserveA,
          tokenBReserve: reserveB,
          poolMint: lpMintA,
          tokenAMint,
          tokenBMint,
        }),
      },
      poolADuplicateMint: {
        exists: true,
        address: 'poolADuplicateMint',
        lamports: 0n,
        programAddress: SABER_SWAP_PROGRAM_ID,
        data: buildSwapAccountData({
          tokenAReserve: reserveB,
          tokenBReserve: reserveA,
          poolMint: lpMintA,
          tokenAMint: tokenBMint,
          tokenBMint: tokenAMint,
        }),
      },
      poolB: {
        exists: true,
        address: 'poolB',
        lamports: 0n,
        programAddress: SABER_SWAP_PROGRAM_ID,
        data: buildSwapAccountData({
          tokenAReserve: reserveA,
          tokenBReserve: reserveB,
          poolMint: lpMintB,
          tokenAMint,
          tokenBMint,
        }),
      },
      poolWrongProgram: {
        exists: true,
        address: 'poolWrongProgram',
        lamports: 0n,
        programAddress: TOKEN_PROGRAM_ID.toBase58(),
        data: buildSwapAccountData({
          tokenAReserve: reserveA,
          tokenBReserve: reserveB,
          poolMint: '11111111111111111111111111111111',
          tokenAMint,
          tokenBMint,
        }),
      },
      poolNotInitialized: {
        exists: true,
        address: 'poolNotInitialized',
        lamports: 0n,
        programAddress: SABER_SWAP_PROGRAM_ID,
        data: buildSwapAccountData({
          tokenAReserve: reserveA,
          tokenBReserve: reserveB,
          poolMint: '11111111111111111111111111111111',
          tokenAMint,
          tokenBMint,
          isInitialized: false,
        }),
      },
      missingPool: {
        exists: false,
        address: 'missingPool',
      },
    }

    const done = await plan.next(discoveryResult)
    expect(done.done).toBe(true)
    if (!done.done) throw new Error('Expected users filter plan to finish')

    const filters = done.value
    expect(filters).toHaveLength(4)

    const pairs = new Set<string>()
    for (const filter of filters) {
      expect(filter.ownerOffset).toBe(TOKEN_ACCOUNT_OWNER_OFFSET)
      expect(filter.memcmps).toHaveLength(1)
      expect(filter.memcmps?.[0]?.offset).toBe(TOKEN_ACCOUNT_MINT_OFFSET)

      const mintBytes = filter.memcmps?.[0]?.bytes
      if (!mintBytes) throw new Error('Expected mint memcmp bytes')
      pairs.add(`${filter.programId}:${new PublicKey(mintBytes).toBase58()}`)
    }

    expect(pairs).toEqual(
      new Set([
        `${TOKEN_PROGRAM_ID.toBase58()}:${lpMintA}`,
        `${TOKEN_2022_PROGRAM_ID.toBase58()}:${lpMintA}`,
        `${TOKEN_PROGRAM_ID.toBase58()}:${lpMintB}`,
        `${TOKEN_2022_PROGRAM_ID.toBase58()}:${lpMintB}`,
      ]),
    )
  })
})

testIntegration(saberIntegration, testAddress)
