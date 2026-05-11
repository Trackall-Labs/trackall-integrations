import { expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import { TokenPlugin } from '../../../types/index'
import { metadaoIntegration, testAddress } from '.'

const LAUNCHPAD_V7_PROGRAM_ID = 'moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM'
const FUNDING_RECORD_FUNDER_OFFSET = 9
const FUNDING_RECORD_LAUNCH_OFFSET = 41
const FUNDING_RECORD_COMMITTED_AMOUNT_OFFSET = 73
const FUNDING_RECORD_IS_TOKENS_CLAIMED_OFFSET = 81
const FUNDING_RECORD_IS_USDC_REFUNDED_OFFSET = 82
const FUNDING_RECORD_APPROVED_AMOUNT_OFFSET = 83
const FUNDING_RECORD_LENGTH = 115

const pubkey = (seed: number) => {
  return new PublicKey(new Uint8Array(32).fill(seed)).toBase58()
}

const fundingRecordDiscriminator = createHash('sha256')
  .update('account:FundingRecord')
  .digest()
  .subarray(0, 8)

function u8(value: number) {
  return Buffer.from([value])
}

function u32(value: number) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

function u64(value: bigint) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(value)
  return buffer
}

function pubkeyBytes(address: string) {
  return new PublicKey(address).toBuffer()
}

function none() {
  return u8(0)
}

function launchData({
  state,
  baseMint,
  quoteMint,
}: {
  state: number
  baseMint: string
  quoteMint: string
}) {
  return Buffer.concat([
    Buffer.alloc(8),
    u8(0),
    u64(0n),
    u64(0n),
    u32(0),
    pubkeyBytes(pubkey(20)),
    pubkeyBytes(pubkey(21)),
    u8(0),
    pubkeyBytes(pubkey(22)),
    pubkeyBytes(pubkey(23)),
    pubkeyBytes(baseMint),
    pubkeyBytes(quoteMint),
    none(),
    none(),
    u64(0n),
    u8(state),
    u64(0n),
    u32(0),
    none(),
    none(),
    pubkeyBytes(pubkey(24)),
    u64(0n),
    u8(0),
    pubkeyBytes(pubkey(25)),
    u64(1_000n),
    u64(0n),
    none(),
    u8(0),
    none(),
  ])
}

function fundingRecordData({
  owner,
  launch,
  committedAmount,
  approvedAmount,
}: {
  owner: string
  launch: string
  committedAmount: bigint
  approvedAmount: bigint
}) {
  const data = Buffer.alloc(FUNDING_RECORD_LENGTH)
  fundingRecordDiscriminator.copy(data, 0)
  pubkeyBytes(owner).copy(data, FUNDING_RECORD_FUNDER_OFFSET)
  pubkeyBytes(launch).copy(data, FUNDING_RECORD_LAUNCH_OFFSET)
  data.writeBigUInt64LE(committedAmount, FUNDING_RECORD_COMMITTED_AMOUNT_OFFSET)
  data[FUNDING_RECORD_IS_TOKENS_CLAIMED_OFFSET] = 0
  data[FUNDING_RECORD_IS_USDC_REFUNDED_OFFSET] = 0
  data.writeBigUInt64LE(approvedAmount, FUNDING_RECORD_APPROVED_AMOUNT_OFFSET)
  return data
}

function existingAccount(address: string, data: Buffer) {
  return {
    exists: true as const,
    address,
    data,
    programAddress: LAUNCHPAD_V7_PROGRAM_ID,
    lamports: 0n,
  }
}

function missingAccount(address: string) {
  return {
    exists: false as const,
    address,
  }
}

const plugins = {
  endpoint: '',
  tokens: new TokenPlugin(),
}

it('returns only funding records for live launches', async () => {
  const owner = testAddress
  const liveLaunch = pubkey(1)
  const completeLaunch = pubkey(2)
  const liveFundingRecord = pubkey(3)
  const completeFundingRecord = pubkey(4)
  const baseMint = pubkey(5)
  const quoteMint = pubkey(6)
  const generator = metadaoIntegration.getUserPositions?.(owner, plugins)

  if (!generator) {
    throw new Error('Expected MetaDAO getUserPositions to be defined')
  }

  const fundingRecordRequest = await generator.next()
  expect(fundingRecordRequest.value).toMatchObject({
    kind: 'getProgramAccounts',
    programId: LAUNCHPAD_V7_PROGRAM_ID,
  })

  const launchRequest = await generator.next({
    [liveFundingRecord]: existingAccount(
      liveFundingRecord,
      fundingRecordData({
        owner,
        launch: liveLaunch,
        committedAmount: 100n,
        approvedAmount: 100n,
      }),
    ),
    [completeFundingRecord]: existingAccount(
      completeFundingRecord,
      fundingRecordData({
        owner,
        launch: completeLaunch,
        committedAmount: 200n,
        approvedAmount: 200n,
      }),
    ),
  })

  expect(launchRequest.value).toEqual([liveLaunch, completeLaunch])

  const mintRequest = await generator.next({
    [liveLaunch]: existingAccount(
      liveLaunch,
      launchData({ state: 1, baseMint, quoteMint }),
    ),
    [completeLaunch]: existingAccount(
      completeLaunch,
      launchData({ state: 3, baseMint: pubkey(7), quoteMint: pubkey(8) }),
    ),
  })

  expect(mintRequest.value).toEqual([baseMint, quoteMint])

  const result = await generator.next({
    [baseMint]: missingAccount(baseMint),
    [quoteMint]: missingAccount(quoteMint),
  })

  if (!result.done) {
    throw new Error('Expected MetaDAO getUserPositions to finish')
  }

  expect(result.value).toHaveLength(1)
  expect(result.value[0]?.meta?.launchpad).toMatchObject({
    launch: liveLaunch,
    fundingRecord: liveFundingRecord,
    state: 'live',
  })
})

it('returns no positions and skips mint fetches when no funding records are live', async () => {
  const owner = testAddress
  const completeLaunch = pubkey(9)
  const fundingRecord = pubkey(10)
  const generator = metadaoIntegration.getUserPositions?.(owner, plugins)

  if (!generator) {
    throw new Error('Expected MetaDAO getUserPositions to be defined')
  }

  await generator.next()

  const launchRequest = await generator.next({
    [fundingRecord]: existingAccount(
      fundingRecord,
      fundingRecordData({
        owner,
        launch: completeLaunch,
        committedAmount: 100n,
        approvedAmount: 100n,
      }),
    ),
  })

  expect(launchRequest.value).toEqual([completeLaunch])

  const result = await generator.next({
    [completeLaunch]: existingAccount(
      completeLaunch,
      launchData({ state: 3, baseMint: pubkey(11), quoteMint: pubkey(12) }),
    ),
  })

  if (!result.done) {
    throw new Error('Expected MetaDAO getUserPositions to finish')
  }

  expect(result.value).toEqual([])
})

testIntegration(metadaoIntegration, testAddress, {
  timeoutMs: 180_000,
})
