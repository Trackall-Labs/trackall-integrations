import { describe, expect, it } from 'bun:test'
import { PublicKey } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import type { SolanaAccount } from '../../../types/index'
import {
  getStakeState,
  PROGRAM_IDS,
  parseStakeAccount,
  readU32,
  readU64,
  STAKE_PROGRAM_ID,
  testAddress,
  validatorsIntegration,
} from './index'

const U64_MAX = 18446744073709551615n
const TEST_STAKE_ACCOUNT = '11111111111111111111111111111112'
const TEST_STAKER = '11111111111111111111111111111113'
const TEST_WITHDRAWER = testAddress
const TEST_VOTE_ACCOUNT = '11111111111111111111111111111114'

testIntegration(validatorsIntegration, testAddress, {
  timeoutMs: 180_000,
})

function writeU32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(
    offset,
    value,
    true,
  )
}

function writeU64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(
    offset,
    value,
    true,
  )
}

function writePubkey(data: Uint8Array, offset: number, value: string): void {
  data.set(new PublicKey(value).toBytes(), offset)
}

function createStakeAccount({
  delegatedStake = 1_500_000_000n,
  activationEpoch = 10n,
  deactivationEpoch = U64_MAX,
}: {
  delegatedStake?: bigint
  activationEpoch?: bigint
  deactivationEpoch?: bigint
} = {}): SolanaAccount {
  const data = new Uint8Array(200)
  writeU32(data, 0, 2)
  writePubkey(data, 12, TEST_STAKER)
  writePubkey(data, 44, TEST_WITHDRAWER)
  writePubkey(data, 124, TEST_VOTE_ACCOUNT)
  writeU64(data, 156, delegatedStake)
  writeU64(data, 164, activationEpoch)
  writeU64(data, 172, deactivationEpoch)

  return {
    exists: true,
    address: TEST_STAKE_ACCOUNT,
    lamports: delegatedStake,
    programAddress: STAKE_PROGRAM_ID,
    data,
  }
}

describe('validators stake account decoding', () => {
  it('reads little-endian integers', () => {
    const data = new Uint8Array(16)
    writeU32(data, 0, 2)
    writeU64(data, 8, 123456789n)

    expect(readU32(data, 0)).toBe(2)
    expect(readU64(data, 8)).toBe(123456789n)
    expect(readU64(data, 9)).toBeNull()
  })

  it('classifies stake accounts against the current epoch', () => {
    expect(getStakeState(10n, U64_MAX, 20n)).toBe('active')
    expect(getStakeState(30n, U64_MAX, 20n)).toBe('activating')
    expect(getStakeState(10n, 30n, 20n)).toBe('deactivating')
    expect(getStakeState(10n, 20n, 20n)).toBe('inactive')
  })

  it('parses delegated stake accounts', () => {
    const parsed = parseStakeAccount(createStakeAccount(), 20n)

    expect(parsed).not.toBeNull()
    expect(parsed?.address).toBe(TEST_STAKE_ACCOUNT)
    expect(parsed?.staker).toBe(TEST_STAKER)
    expect(parsed?.withdrawer).toBe(TEST_WITHDRAWER)
    expect(parsed?.voteAccount).toBe(TEST_VOTE_ACCOUNT)
    expect(parsed?.delegatedStake).toBe(1_500_000_000n)
    expect(parsed?.state).toBe('active')
  })

  it('skips non-delegated stake accounts', () => {
    const account = createStakeAccount({ delegatedStake: 0n })

    expect(parseStakeAccount(account, 20n)).toBeNull()
  })
})

describe('validators integration metadata', () => {
  it('exports the native stake program id', () => {
    expect(PROGRAM_IDS).toEqual([STAKE_PROGRAM_ID])
  })

  it('builds a withdraw-authority users filter for delegated stake accounts', () => {
    const filters = validatorsIntegration.getUsersFilter?.()

    expect(Array.isArray(filters)).toBe(true)
    if (!Array.isArray(filters)) throw new Error('Expected static filters')

    expect(filters).toHaveLength(1)
    expect(filters[0]).toEqual({
      programId: STAKE_PROGRAM_ID,
      discriminator: Uint8Array.from([2, 0, 0, 0]),
      ownerOffset: 44,
      dataSize: 200,
    })
  })
})
