import { describe, expect, it } from 'bun:test'
// import { AMM_V4 } from '@raydium-io/raydium-sdk-v2'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import type {
  AccountsMap,
  ProgramRequest,
  // UsersFilterPlan,
} from '../../../types/index'
import { runIntegrations, TokenPlugin } from '../../../types/index'
import {
  fetchAccountsBatch,
  fetchProgramAccountsBatch,
} from '../../../utils/solana'
import clmmIdl from './idls/amm_v3.json'
// import cpIdl from './idls/raydium_cp_swap.json'
import {
  computeAmmV4UserAmounts,
  computeCpUserAmounts,
  raydiumIntegration,
} from './index'

const solanaRpcUrl =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const wallet = '93PSyNrS7zBhrXaHHfU1ZtfegcKq5SaCYc35ZwPVrK3K'

const { getUserPositions } = raydiumIntegration
if (!getUserPositions) throw new Error('getUserPositions not implemented')

// function idlDiscriminator(
//   idl: { accounts?: Array<{ name: string; discriminator?: number[] }> },
//   accountName: string,
// ): Buffer {
//   const discriminator = idl.accounts?.find(
//     (a) => a.name === accountName,
//   )?.discriminator
//   if (!discriminator)
//     throw new Error(`Missing discriminator for ${accountName}`)
//   return Buffer.from(discriminator)
// }

function buildTokenAccountData(mint: PublicKey, amount: bigint): Uint8Array {
  const buf = Buffer.alloc(165, 0)
  mint.toBuffer().copy(buf, 0)
  buf.writeBigUInt64LE(amount, 64)
  return new Uint8Array(buf)
}

// function buildCpPoolStateData(lpMint: PublicKey): Uint8Array {
//   const buf = Buffer.alloc(413, 0)
//   idlDiscriminator(cpIdl, 'PoolState').copy(buf, 0)
//   lpMint.toBuffer().copy(buf, 136)
//   return new Uint8Array(buf)
// }

// function buildAmmV4PoolStateData(lpMint: PublicKey): Uint8Array {
//   const buf = Buffer.alloc(752, 0)
//   lpMint.toBuffer().copy(buf, 464)
//   return new Uint8Array(buf)
// }

// function buildClmmPersonalPositionData(nftMint: PublicKey): Uint8Array {
//   const buf = Buffer.alloc(281, 0)
//   idlDiscriminator(clmmIdl, 'PersonalPositionState').copy(buf, 0)
//   buf.writeUInt8(1, 8) // bump
//   nftMint.toBuffer().copy(buf, 9)
//   return new Uint8Array(buf)
// }

describe('raydium integration', () => {
  // it('starts users filter discovery across CP, AMM v4 and CLMM accounts', async () => {
  //   const plan = getUsersFilter() as UsersFilterPlan
  //
  //   const first = await plan.next()
  //   if (first.done) throw new Error('Expected discovery requests')
  //   if (!Array.isArray(first.value)) {
  //     throw new Error('Expected discovery request array')
  //   }
  //
  //   const requests = first.value
  //   expect(requests).toHaveLength(3)
  //
  //   const cpRequest = requests.find(
  //     (req) =>
  //       req.kind === 'getProgramAccounts' && req.programId === cpIdl.address,
  //   )
  //   expect(cpRequest).toBeDefined()
  //   expect(cpRequest).toEqual({
  //     kind: 'getProgramAccounts',
  //     programId: cpIdl.address,
  //     cacheTtlMs: 60 * 60 * 1000,
  //     filters: [
  //       {
  //         memcmp: {
  //           offset: 0,
  //           bytes: idlDiscriminator(cpIdl, 'PoolState').toString('base64'),
  //           encoding: 'base64',
  //         },
  //       },
  //     ],
  //   })
  //
  //   const ammV4Request = requests.find(
  //     (req) =>
  //       req.kind === 'getProgramAccounts' &&
  //       req.programId === AMM_V4.toBase58(),
  //   )
  //   expect(ammV4Request).toBeDefined()
  //   expect(ammV4Request).toEqual({
  //     kind: 'getProgramAccounts',
  //     programId: AMM_V4.toBase58(),
  //     cacheTtlMs: 60 * 60 * 1000,
  //     filters: [{ dataSize: 752 }],
  //   })
  //
  //   const clmmRequest = requests.find(
  //     (req) =>
  //       req.kind === 'getProgramAccounts' &&
  //       req.programId === (clmmIdl as { address: string }).address,
  //   )
  //   expect(clmmRequest).toBeDefined()
  //   expect(clmmRequest).toEqual({
  //     kind: 'getProgramAccounts',
  //     programId: (clmmIdl as { address: string }).address,
  //     cacheTtlMs: 60 * 60 * 1000,
  //     filters: [
  //       {
  //         memcmp: {
  //           offset: 0,
  //           bytes: idlDiscriminator(clmmIdl, 'PersonalPositionState').toString(
  //             'base64',
  //           ),
  //           encoding: 'base64',
  //         },
  //       },
  //     ],
  //   })
  //
  //   const done = await plan.next({})
  //   expect(done.done).toBe(true)
  //   if (!done.done) throw new Error('Expected users filter plan to finish')
  //   expect(done.value).toEqual([])
  // })

  // it('discovers Raydium mints and builds holder filters on both token programs', async () => {
  //   const cpLpMint = new PublicKey(
  //     'So11111111111111111111111111111111111111112',
  //   )
  //   const ammLpMint = new PublicKey(
  //     'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  //   )
  //   const clmmNftMint = new PublicKey(
  //     'Es9vMFrzaCER8f6A2QxYDs2fzGEGZm4G6dkprdFM5oc',
  //   )
  //
  //   const plan = getUsersFilter() as UsersFilterPlan
  //   const first = await plan.next()
  //   if (first.done) throw new Error('Expected discovery requests')
  //
  //   const done = await plan.next({
  //     cpPool: {
  //       exists: true,
  //       address: 'cpPool',
  //       lamports: 0n,
  //       programAddress: cpIdl.address,
  //       data: buildCpPoolStateData(cpLpMint),
  //     },
  //     ammPool: {
  //       exists: true,
  //       address: 'ammPool',
  //       lamports: 0n,
  //       programAddress: AMM_V4.toBase58(),
  //       data: buildAmmV4PoolStateData(ammLpMint),
  //     },
  //     clmmPosition: {
  //       exists: true,
  //       address: 'clmmPosition',
  //       lamports: 0n,
  //       programAddress: (clmmIdl as { address: string }).address,
  //       data: buildClmmPersonalPositionData(clmmNftMint),
  //     },
  //     malformedClmm: {
  //       exists: true,
  //       address: 'malformedClmm',
  //       lamports: 0n,
  //       programAddress: (clmmIdl as { address: string }).address,
  //       data: new Uint8Array([1, 2, 3]),
  //     },
  //   })
  //
  //   expect(done.done).toBe(true)
  //   if (!done.done) throw new Error('Expected users filter plan to finish')
  //
  //   const pairs = new Set(
  //     done.value.map((filter) => {
  //       const mintBytes = filter.memcmps?.[0]?.bytes
  //       if (!mintBytes) throw new Error('Expected mint memcmp bytes')
  //       return `${filter.programId}:${new PublicKey(mintBytes).toBase58()}`
  //     }),
  //   )
  //
  //   expect(pairs).toEqual(
  //     new Set([
  //       `${TOKEN_PROGRAM_ID.toBase58()}:${cpLpMint.toBase58()}`,
  //       `${TOKEN_2022_PROGRAM_ID.toBase58()}:${cpLpMint.toBase58()}`,
  //       `${TOKEN_PROGRAM_ID.toBase58()}:${ammLpMint.toBase58()}`,
  //       `${TOKEN_2022_PROGRAM_ID.toBase58()}:${ammLpMint.toBase58()}`,
  //       `${TOKEN_PROGRAM_ID.toBase58()}:${clmmNftMint.toBase58()}`,
  //       `${TOKEN_2022_PROGRAM_ID.toBase58()}:${clmmNftMint.toBase58()}`,
  //     ]),
  //   )
  // })

  // it('builds token holder filters for both token programs and dedupes mints', () => {
  //   const mintA = 'So11111111111111111111111111111111111111112'
  //   const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  //
  //   const filters = buildTokenHolderUsersFiltersByMints([mintA, mintB, mintA])
  //   expect(filters).toHaveLength(4)
  //
  //   const pairs = new Set(
  //     filters.map((filter) => {
  //       const mintBytes = filter.memcmps?.[0]?.bytes
  //       if (!mintBytes) throw new Error('Expected mint memcmp bytes')
  //       return `${filter.programId}:${new PublicKey(mintBytes).toBase58()}`
  //     }),
  //   )
  //
  //   expect(pairs).toEqual(
  //     new Set([
  //       `${TOKEN_PROGRAM_ID.toBase58()}:${mintA}`,
  //       `${TOKEN_2022_PROGRAM_ID.toBase58()}:${mintA}`,
  //       `${TOKEN_PROGRAM_ID.toBase58()}:${mintB}`,
  //       `${TOKEN_2022_PROGRAM_ID.toBase58()}:${mintB}`,
  //     ]),
  //   )
  // })

  it('uses fee-adjusted CPMM reserves for LP share amounts', () => {
    const { amount0, amount1 } = computeCpUserAmounts({
      vault0Balance: 4_000_000_000n, // 4 SOL raw in vault
      vault1Balance: 2_000_000_000n,
      userLpAmount: 100n,
      lpSupply: 1_000n,
      protocolFeesToken0: 3_900_000_000n, // leaves only 0.1 SOL effective reserve
      protocolFeesToken1: 0n,
      fundFeesToken0: 0n,
      fundFeesToken1: 0n,
      creatorFeesToken0: 0n,
      creatorFeesToken1: 0n,
    })

    expect(amount0).toBe(10_000_000n) // 0.01 SOL, not 0.4 SOL
    expect(amount1).toBe(200_000_000n)
  })

  it('uses AMM v4 lpReserve and needTakePnl-adjusted reserves', () => {
    const { amount0, amount1 } = computeAmmV4UserAmounts({
      baseVaultBalance: 5_000_000_000n,
      quoteVaultBalance: 3_000_000_000n,
      userLpAmount: 100n,
      lpReserve: 10_000n,
      baseNeedTakePnl: 4_000_000_000n,
      quoteNeedTakePnl: 2_500_000_000n,
    })

    expect(amount0).toBe(10_000_000n)
    expect(amount1).toBe(5_000_000n)
  })

  it('uses split mint sources: SPL for CP/AMM and NFT-like Token-2022 for CLMM', async () => {
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    const splMint = new PublicKey('So11111111111111111111111111111111111111112')
    const token2022NftMint = new PublicKey(
      'Es9vMFrzaCER8f6A2QxYDs2fzGEGZm4G6dkprdFM5oc',
    )
    const token2022NonNftMint = new PublicKey(
      'NFTUkR4u7wKxy9QLaX2TGvd9oZSWoMo4jqSJqdMb7Nk',
    )

    const clmmProgram = new PublicKey((clmmIdl as { address: string }).address)
    const [splClmmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), splMint.toBuffer()],
      clmmProgram,
    )
    const [token2022NftClmmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), token2022NftMint.toBuffer()],
      clmmProgram,
    )
    const [token2022NonNftClmmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), token2022NonNftMint.toBuffer()],
      clmmProgram,
    )

    let capturedPhase2Addresses: string[] = []
    const queriedMints = new Set<string>()
    let getProgramAccountsCalls = 0

    const [positions] = await runIntegrations(
      [getUserPositions(wallet, plugins)],
      async (addresses) => {
        if (addresses.length > 0) capturedPhase2Addresses = [...addresses]
        return {}
      },
      async (req: ProgramRequest): Promise<AccountsMap> => {
        if (req.kind === 'getTokenAccountsByOwner') {
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
        }

        if (req.kind !== 'getProgramAccounts') return {}

        getProgramAccountsCalls++
        const mintFilter = req.filters.find(
          (f: (typeof req.filters)[number]) =>
            'memcmp' in f && f.memcmp.offset !== 0,
        )
        if (mintFilter && 'memcmp' in mintFilter) {
          queriedMints.add(mintFilter.memcmp.bytes)
        }
        return {}
      },
    )

    expect(positions).toEqual([])
    expect(getProgramAccountsCalls).toBe(2)
    expect(queriedMints.has(splMint.toBase58())).toBe(true)
    expect(queriedMints.has(token2022NftMint.toBase58())).toBe(false)
    expect(queriedMints.has(token2022NonNftMint.toBase58())).toBe(false)
    expect(capturedPhase2Addresses).toEqual([token2022NftClmmPda.toBase58()])
    expect(capturedPhase2Addresses.includes(splClmmPda.toBase58())).toBe(false)
    expect(
      capturedPhase2Addresses.includes(token2022NonNftClmmPda.toBase58()),
    ).toBe(false)
  })

  it('skips CLMM PDA fetch for Token-2022 mint balances greater than 1', async () => {
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    const token2022NonNftMint = new PublicKey(
      'NFTUkR4u7wKxy9QLaX2TGvd9oZSWoMo4jqSJqdMb7Nk',
    )
    const clmmProgram = new PublicKey((clmmIdl as { address: string }).address)
    const [token2022NonNftClmmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), token2022NonNftMint.toBuffer()],
      clmmProgram,
    )

    let batchFetchCalls = 0
    let capturedPhase2Addresses: string[] = []
    let getProgramAccountsCalls = 0

    const [positions] = await runIntegrations(
      [getUserPositions(wallet, plugins)],
      async (addresses) => {
        batchFetchCalls++
        capturedPhase2Addresses = [...addresses]
        return {}
      },
      async (req: ProgramRequest): Promise<AccountsMap> => {
        if (req.kind === 'getTokenAccountsByOwner') {
          if (req.programId === TOKEN_PROGRAM_ID.toBase58()) return {}
          if (req.programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
            return {
              token2022NonNftAta: {
                exists: true,
                address: 'token2022NonNftAta',
                lamports: 0n,
                programAddress: TOKEN_2022_PROGRAM_ID.toBase58(),
                data: buildTokenAccountData(token2022NonNftMint, 7n),
              },
            }
          }
          return {}
        }
        if (req.kind === 'getProgramAccounts') getProgramAccountsCalls++
        return {}
      },
    )

    expect(positions).toEqual([])
    expect(getProgramAccountsCalls).toBe(0)
    expect(batchFetchCalls).toBe(0)
    expect(
      capturedPhase2Addresses.includes(token2022NonNftClmmPda.toBase58()),
    ).toBe(false)
  })

  it('fetches user positions from Raydium CLMM + CP', async () => {
    const connection = new Connection(solanaRpcUrl, 'confirmed')
    const tokens = new TokenPlugin()
    const plugins = { endpoint: solanaRpcUrl, tokens }

    let totalBatches = 0
    let totalAccounts = 0
    let getProgramAccountsCalls = 0
    let getTokenAccountsByOwnerCalls = 0

    const [positions] = await runIntegrations(
      [getUserPositions(wallet, plugins)],
      async (addresses) => {
        totalBatches++
        totalAccounts += addresses.length
        console.log(
          `  batch ${totalBatches}: fetching ${addresses.length} accounts`,
        )
        return fetchAccountsBatch(connection, addresses)
      },
      (req) => {
        if (req.kind === 'getProgramAccounts') {
          getProgramAccountsCalls++
        } else if (req.kind === 'getTokenAccountsByOwner') {
          getTokenAccountsByOwnerCalls++
        }
        return fetchProgramAccountsBatch(connection, req)
      },
    )

    if (!positions) throw new Error('No results returned')

    const liquidityPositions = positions.filter(
      (p) => p.positionKind === 'liquidity',
    )

    console.log(`\nFound ${positions.length} Raydium positions`)
    console.log(
      `RPC batches: ${totalBatches}, total accounts fetched: ${totalAccounts}`,
    )
    console.log(
      `Program requests: getProgramAccounts=${getProgramAccountsCalls}, getTokenAccountsByOwner=${getTokenAccountsByOwnerCalls}`,
    )
    console.log('Sample position:', JSON.stringify(liquidityPositions, null, 2))

    expect(Array.isArray(positions)).toBe(true)
    expect(getProgramAccountsCalls).toBe(0)
    expect(getTokenAccountsByOwnerCalls).toBe(2)
  }, 1800000)
})
