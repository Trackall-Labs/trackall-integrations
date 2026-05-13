import { describe, expect, it } from 'bun:test'
import { PublicKey } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import {
  type AccountsMap,
  type ProgramRequest,
  runIntegrations,
  type SolanaAddress,
  TokenPlugin,
} from '../../../types/index'
import { testAddress, zeusIntegration } from '.'

testIntegration(zeusIntegration, testAddress)

const ZEUS_PROGRAM_ID = 'SYNMjud3ALEaeJhxuq8gpc2wJzC4XLHfxp9SgKmzQ8r'
const OWNER = testAddress
const USER_POSITION = 'D3Bi4z8dacbw7bCjmbxsA9LCnAux94csoa6JsQkryRAP'
const REDEEM_REQUEST = '8E9pnCkYS5C3zt7uMc8phV3rhHQE5zHGKv7uYbrp4WYQ'
const STRATEGY_GROUP = '9HGpvmW1Lv2pqKkbM41pGm7ApMjgdXt7Refdv5hoFejJ'
const ZBTC_MINT = 'zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg'
const JUPSOL_MINT = 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v'

const USER_POSITION_DISCRIMINATOR = new Uint8Array([
  251, 248, 209, 245, 83, 234, 17, 27,
])
const REDEEM_REQUEST_DISCRIMINATOR = new Uint8Array([
  103, 82, 139, 51, 199, 234, 111, 115,
])
const USER_POSITION_DISCRIMINATOR_B64 = Buffer.from(
  USER_POSITION_DISCRIMINATOR,
).toString('base64')

function writePubkey(data: Uint8Array, offset: number, address: string) {
  data.set(new PublicKey(address).toBytes(), offset)
}

function writeU64(data: Uint8Array, offset: number, value: bigint) {
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).writeBigUInt64LE(
    value,
    offset,
  )
}

function writeI64(data: Uint8Array, offset: number, value: bigint) {
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).writeBigInt64LE(
    value,
    offset,
  )
}

function writeU128(data: Uint8Array, offset: number, value: bigint) {
  writeU64(data, offset, value & ((1n << 64n) - 1n))
  writeU64(data, offset + 8, value >> 64n)
}

function account(address: string, data: Uint8Array) {
  return {
    exists: true as const,
    address,
    lamports: 0n,
    programAddress: ZEUS_PROGRAM_ID,
    data,
  }
}

function buildUserPosition(params: {
  syntheticAmount: bigint
  receiptOwedScaled: bigint
  receiptLastAccumulated: bigint
}) {
  const data = new Uint8Array(1041)
  data.set(USER_POSITION_DISCRIMINATOR, 0)
  writePubkey(data, 40, OWNER)
  writePubkey(data, 72, STRATEGY_GROUP)
  writeU64(data, 168, params.syntheticAmount)

  const receiptBase = 193
  writePubkey(data, receiptBase + 32, ZBTC_MINT)
  writeU128(data, receiptBase + 64, params.receiptOwedScaled)
  writeU128(data, receiptBase + 80, params.receiptLastAccumulated)

  return data
}

function buildRedeemRequest() {
  const data = new Uint8Array(200)
  data.set(REDEEM_REQUEST_DISCRIMINATOR, 0)
  writePubkey(data, 8, OWNER)
  writePubkey(data, 72, STRATEGY_GROUP)
  writePubkey(data, 104, JUPSOL_MINT)
  writeU64(data, 136, 1n)
  writeU64(data, 144, 1n)
  writeI64(data, 184, 0n)
  return data
}

function buildStrategyGroup(params: {
  minAmountToClaim: bigint
  accumulatedAmountScaledPerShare: bigint
}) {
  const data = new Uint8Array(4360)

  const underlyingBase = 360
  writePubkey(data, underlyingBase, JUPSOL_MINT)
  writeU128(data, underlyingBase + 256, 10n ** 12n)
  data[underlyingBase + 376] = 9

  const treasuryBase = 1560
  writePubkey(data, treasuryBase, ZBTC_MINT)
  writeU64(data, treasuryBase + 192, params.minAmountToClaim)
  writeU128(data, treasuryBase + 320, params.accumulatedAmountScaledPerShare)

  return data
}

async function runZeusFixture(params: {
  syntheticAmount: bigint
  receiptOwedScaled: bigint
  receiptLastAccumulated: bigint
  accumulatedAmountScaledPerShare: bigint
  minAmountToClaim?: bigint
  includeRedeemRequest?: boolean
}) {
  const userPosition = account(
    USER_POSITION,
    buildUserPosition({
      syntheticAmount: params.syntheticAmount,
      receiptOwedScaled: params.receiptOwedScaled,
      receiptLastAccumulated: params.receiptLastAccumulated,
    }),
  )
  const redeemRequest = account(REDEEM_REQUEST, buildRedeemRequest())
  const strategyGroup = account(
    STRATEGY_GROUP,
    buildStrategyGroup({
      minAmountToClaim: params.minAmountToClaim ?? 10n,
      accumulatedAmountScaledPerShare: params.accumulatedAmountScaledPerShare,
    }),
  )
  const getUserPositions = zeusIntegration.getUserPositions
  if (!getUserPositions) throw new Error('Zeus getUserPositions is missing')

  const [positions] = await runIntegrations(
    [
      getUserPositions(OWNER, {
        endpoint: 'mock',
        tokens: new TokenPlugin(':memory:'),
      }),
    ],
    async (addresses: SolanaAddress[]): Promise<AccountsMap> => {
      expect(addresses).toEqual([STRATEGY_GROUP])
      return { [STRATEGY_GROUP]: strategyGroup }
    },
    async (request: ProgramRequest): Promise<AccountsMap> => {
      if (
        request.kind === 'getProgramAccounts' &&
        request.filters.some(
          (filter) =>
            'memcmp' in filter &&
            filter.memcmp.offset === 0 &&
            filter.memcmp.bytes === USER_POSITION_DISCRIMINATOR_B64,
        )
      ) {
        return { [USER_POSITION]: userPosition }
      }

      return params.includeRedeemRequest
        ? { [REDEEM_REQUEST]: redeemRequest }
        : {}
    },
  )

  return positions ?? []
}

describe('zeus local treasury rewards', () => {
  it('computes accrued zBTC rewards without simulation', async () => {
    const positions = await runZeusFixture({
      syntheticAmount: 1029704764n,
      receiptOwedScaled: 0n,
      receiptLastAccumulated: 138547945n,
      accumulatedAmountScaledPerShare: 5162332638n,
    })

    expect(positions[0]?.rewards?.[0]?.amount.amount).toBe('5173')
  })

  it('includes stored owed rewards for an active redeem-only strategy', async () => {
    const positions = await runZeusFixture({
      syntheticAmount: 0n,
      receiptOwedScaled: 3635953500n,
      receiptLastAccumulated: 4967183086n,
      accumulatedAmountScaledPerShare: 6024370732n,
      includeRedeemRequest: true,
    })

    expect(positions[0]?.rewards?.[0]?.amount.amount).toBe('3635')
  })

  it('omits rewards below the protocol claim threshold', async () => {
    const positions = await runZeusFixture({
      syntheticAmount: 10n ** 9n,
      receiptOwedScaled: 0n,
      receiptLastAccumulated: 0n,
      accumulatedAmountScaledPerShare: 9_000_000n,
    })

    expect(positions[0]?.rewards).toBeUndefined()
  })
})
