import { describe, expect, it } from 'bun:test'
import { ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil } from '@orca-so/whirlpools-sdk'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { testIntegration } from '../../../test/solana-integration'
import type { AccountsMap, ProgramRequest } from '../../../types/index'
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

testIntegration(orcaIntegration, testAddress)
