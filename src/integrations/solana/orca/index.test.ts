import { describe, expect, it } from 'bun:test'
import { BN } from '@coral-xyz/anchor'
import {
  AccountName,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  PriceMath,
  WHIRLPOOL_CODER,
} from '@orca-so/whirlpools-sdk'
import {
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import type {
  AccountsMap,
  ConcentratedRangeLiquidityDefiPosition,
  MaybeSolanaAccount,
  ProgramRequest,
} from '../../../types/index'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import { orcaIntegration, testAddress } from '.'

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

const { getUserPositions } = orcaIntegration
if (!getUserPositions) throw new Error('getUserPositions not implemented')

function buildTokenAccountData(mint: PublicKey, amount: bigint): Uint8Array {
  const buf = Buffer.alloc(165, 0)
  mint.toBuffer().copy(buf, 0)
  buf.writeBigUInt64LE(amount, 64)
  return new Uint8Array(buf)
}

function testPublicKey(seed: number): PublicKey {
  const bytes = new Uint8Array(32)
  bytes[31] = seed
  return new PublicKey(bytes)
}

function buildMintData(decimals: number): Uint8Array {
  const data = Buffer.alloc(MINT_SIZE)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  )
  return new Uint8Array(data)
}

function existingAccount(
  address: string,
  programAddress: string,
  data: Uint8Array,
): MaybeSolanaAccount {
  return {
    exists: true,
    address,
    lamports: 0n,
    programAddress,
    data,
  }
}

async function encodeWhirlpoolAccount(
  tokenMintA: PublicKey,
  tokenMintB: PublicKey,
  rewardMint: PublicKey,
): Promise<Uint8Array> {
  const data = await WHIRLPOOL_CODER.encode(AccountName.Whirlpool, {
    whirlpoolsConfig: testPublicKey(101),
    whirlpoolBump: [1],
    feeRate: 64,
    protocolFeeRate: 0,
    liquidity: new BN(0),
    sqrtPrice: PriceMath.tickIndexToSqrtPriceX64(0),
    tickCurrentIndex: 0,
    protocolFeeOwedA: new BN(0),
    protocolFeeOwedB: new BN(0),
    tokenMintA,
    tokenVaultA: testPublicKey(102),
    feeGrowthGlobalA: new BN('100000000000000000000'),
    tokenMintB,
    tokenVaultB: testPublicKey(103),
    feeGrowthGlobalB: new BN('200000000000000000000'),
    rewardLastUpdatedTimestamp: new BN(1),
    rewardInfos: [
      {
        mint: rewardMint,
        vault: testPublicKey(104),
        emissionsPerSecondX64: new BN('100000000000000000000'),
        growthGlobalX64: new BN('300000000000000000000'),
        extension: Array(32).fill(0),
      },
      {
        mint: PublicKey.default,
        vault: PublicKey.default,
        emissionsPerSecondX64: new BN(0),
        growthGlobalX64: new BN(0),
        extension: Array(32).fill(0),
      },
      {
        mint: PublicKey.default,
        vault: PublicKey.default,
        emissionsPerSecondX64: new BN(0),
        growthGlobalX64: new BN(0),
        extension: Array(32).fill(0),
      },
    ],
    tickSpacing: 1,
    feeTierIndexSeed: [1, 0],
  })

  return new Uint8Array(data)
}

async function encodePositionAccount(
  whirlpool: PublicKey,
  positionMint: PublicKey,
): Promise<Uint8Array> {
  const data = await WHIRLPOOL_CODER.encode(AccountName.Position, {
    whirlpool,
    positionMint,
    liquidity: new BN(0),
    tickLowerIndex: -10,
    tickUpperIndex: 10,
    feeGrowthCheckpointA: new BN(0),
    feeOwedA: new BN(1234),
    feeGrowthCheckpointB: new BN(0),
    feeOwedB: new BN(5000),
    rewardInfos: [
      {
        growthInsideCheckpoint: new BN(0),
        amountOwed: new BN(7),
      },
      {
        growthInsideCheckpoint: new BN(0),
        amountOwed: new BN(0),
      },
      {
        growthInsideCheckpoint: new BN(0),
        amountOwed: new BN(0),
      },
    ],
  })

  return new Uint8Array(data)
}

describe('orca integration candidate mint collection', () => {
  it('allows all SPL token mints while requiring Token-2022 amount=1', async () => {
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }
    const wallet = '93PSyNrS7zBhrXaHHfU1ZtfegcKq5SaCYc35ZwPVrK3K'

    const splMint = new PublicKey('So11111111111111111111111111111111111111112')
    const token2022NftMint = new PublicKey(
      'Es9vMFrzaCER8f6A2QxYDs2fzGEGZm4G6dkprdFM5oc',
    )
    const token2022NonNftMint = new PublicKey(
      'NFTUkR4u7wKxy9QLaX2TGvd9oZSWoMo4jqSJqdMb7Nk',
    )

    const expectedSplPosition = PDAUtil.getPosition(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      splMint,
    ).publicKey.toBase58()
    const expectedSplBundle = PDAUtil.getPositionBundle(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      splMint,
    ).publicKey.toBase58()
    const expectedToken2022Position = PDAUtil.getPosition(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      token2022NftMint,
    ).publicKey.toBase58()
    const skippedToken2022Position = PDAUtil.getPosition(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      token2022NonNftMint,
    ).publicKey.toBase58()
    const token2022Bundle = PDAUtil.getPositionBundle(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      token2022NftMint,
    ).publicKey.toBase58()

    let accountBatchCalls = 0
    let capturedCandidateAddresses: string[] = []
    let getProgramAccountsCalls = 0

    const [positions] = await runIntegrations(
      [getUserPositions(wallet, plugins)],
      async (addresses) => {
        accountBatchCalls++
        capturedCandidateAddresses = [...addresses]
        return {}
      },
      async (req: ProgramRequest): Promise<AccountsMap> => {
        if (req.kind === 'getProgramAccounts') {
          getProgramAccountsCalls++
          return {}
        }

        if (req.kind !== 'getTokenAccountsByOwner') return {}

        if (req.programId === TOKEN_PROGRAM_ID.toBase58()) {
          return {
            splAta: {
              exists: true,
              address: 'splAta',
              lamports: 0n,
              programAddress: TOKEN_PROGRAM_ID.toBase58(),
              data: buildTokenAccountData(splMint, 5n),
            },
          }
        }

        if (req.programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
          return {
            token2022NftAta: {
              exists: true,
              address: 'token2022NftAta',
              lamports: 0n,
              programAddress: TOKEN_2022_PROGRAM_ID.toBase58(),
              data: buildTokenAccountData(token2022NftMint, 1n),
            },
            token2022NonNftAta: {
              exists: true,
              address: 'token2022NonNftAta',
              lamports: 0n,
              programAddress: TOKEN_2022_PROGRAM_ID.toBase58(),
              data: buildTokenAccountData(token2022NonNftMint, 2n),
            },
          }
        }

        return {}
      },
    )

    expect(positions).toEqual([])
    expect(accountBatchCalls).toBe(1)
    expect(getProgramAccountsCalls).toBe(0)

    const candidateAddressSet = new Set(capturedCandidateAddresses)
    expect(candidateAddressSet.has(expectedSplPosition)).toBe(true)
    expect(candidateAddressSet.has(expectedSplBundle)).toBe(true)
    expect(candidateAddressSet.has(expectedToken2022Position)).toBe(true)
    expect(candidateAddressSet.has(skippedToken2022Position)).toBe(false)
    expect(candidateAddressSet.has(token2022Bundle)).toBe(false)
  })
})

describe('orca integration on-chain fee and reward amounts', () => {
  it('uses stored position owed amounts without tick or clock quote estimation', async () => {
    const tokens = new TokenPlugin(':memory:')
    const plugins = { endpoint: solanaRpcUrl, tokens }
    const wallet = '93PSyNrS7zBhrXaHHfU1ZtfegcKq5SaCYc35ZwPVrK3K'

    const positionMint = testPublicKey(1)
    const whirlpoolAddress = testPublicKey(2)
    const tokenMintA = testPublicKey(3)
    const tokenMintB = testPublicKey(4)
    const rewardMint = testPublicKey(5)
    const positionAddress = PDAUtil.getPosition(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      positionMint,
    ).publicKey.toBase58()

    tokens.set(tokenMintA.toBase58(), {
      mintAddress: tokenMintA.toBase58(),
      decimals: 2,
      priceUsd: 2,
    })
    tokens.set(tokenMintB.toBase58(), {
      mintAddress: tokenMintB.toBase58(),
      decimals: 3,
      priceUsd: 3,
    })
    tokens.set(rewardMint.toBase58(), {
      mintAddress: rewardMint.toBase58(),
      decimals: 0,
      priceUsd: 4,
    })

    const positionAccount = existingAccount(
      positionAddress,
      ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(),
      await encodePositionAccount(whirlpoolAddress, positionMint),
    )
    const whirlpoolAccount = existingAccount(
      whirlpoolAddress.toBase58(),
      ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(),
      await encodeWhirlpoolAccount(tokenMintA, tokenMintB, rewardMint),
    )

    const accountMap: AccountsMap = {
      [positionAddress]: positionAccount,
      [whirlpoolAddress.toBase58()]: whirlpoolAccount,
      [tokenMintA.toBase58()]: existingAccount(
        tokenMintA.toBase58(),
        TOKEN_PROGRAM_ID.toBase58(),
        buildMintData(2),
      ),
      [tokenMintB.toBase58()]: existingAccount(
        tokenMintB.toBase58(),
        TOKEN_PROGRAM_ID.toBase58(),
        buildMintData(3),
      ),
      [rewardMint.toBase58()]: existingAccount(
        rewardMint.toBase58(),
        TOKEN_PROGRAM_ID.toBase58(),
        buildMintData(0),
      ),
    }

    const accountFetches: string[][] = []
    const results = await runIntegrations(
      [getUserPositions(wallet, plugins)],
      async (addresses) => {
        accountFetches.push([...addresses])
        return Object.fromEntries(
          addresses.flatMap((address) => {
            const account = accountMap[address]
            return account ? [[address, account]] : []
          }),
        )
      },
      async (req: ProgramRequest): Promise<AccountsMap> => {
        if (req.kind !== 'getTokenAccountsByOwner') return {}
        if (req.programId !== TOKEN_PROGRAM_ID.toBase58()) return {}

        return {
          positionTokenAccount: existingAccount(
            'positionTokenAccount',
            TOKEN_PROGRAM_ID.toBase58(),
            buildTokenAccountData(positionMint, 1n),
          ),
        }
      },
    )
    const positions = results[0]

    expect(positions).toBeDefined()
    if (!positions) throw new Error('missing Orca positions result')
    expect(positions).toHaveLength(1)

    const position = positions[0] as ConcentratedRangeLiquidityDefiPosition
    expect(position.fees?.map((fee) => fee.amount.amount)).toEqual([
      '1234',
      '5000',
    ])
    expect(position.fees?.map((fee) => fee.usdValue)).toEqual(['24.68', '15'])
    expect(position.rewards?.map((reward) => reward.amount.amount)).toEqual([
      '7',
    ])
    expect(position.rewards?.map((reward) => reward.usdValue)).toEqual(['28'])

    expect(accountFetches).toHaveLength(3)
    expect(accountFetches[1]).toEqual([whirlpoolAddress.toBase58()])
    expect(accountFetches.flat()).not.toContain(
      'SysvarC1ock11111111111111111111111111111111',
    )
  })
})

testIntegration(orcaIntegration, testAddress)
