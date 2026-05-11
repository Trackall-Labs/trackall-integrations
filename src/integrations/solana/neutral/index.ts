import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import type {
  LendingDefiPosition,
  ProgramRequest,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'
import { ONE_HOUR_IN_MS } from '../../../utils/solana'
import neutralVaults from './vaults.json'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const BUNDLE_PROGRAM_ID_V1 = 'BUNDDh4P5XviMm1f3gCvnq2qKx6TGosAGnoUK12e7cXU'
const BUNDLE_PROGRAM_ID_V2 = 'BUNDeH5A4c47bcEoAjBhN3sCjLgYnRsmt9ibMztqVkC9'
const DRIFT_VAULT_PROGRAM_ID_DEFAULT =
  'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR'

const BUNDLE_SEED_USER = Buffer.from('USER_BUNDLE')
const DRIFT_DEPOSITOR_AUTHORITY_OFFSET = 8 + 32 + 32

const TOKEN_BY_SYMBOL: Record<string, { token: string; decimals: number }> = {
  USDC: { token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { token: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  SOL: { token: 'So11111111111111111111111111111111111111112', decimals: 9 },
}

interface NeutralVault {
  vaultId: number
  name: string
  subname?: string
  type: 'Bundle' | 'Drift' | 'Kamino' | 'Hyperliquid'
  category: string
  vaultAddress: string
  depositToken: string
  pfee?: number
  driftProgramId?: string
  bundleProgramId?: string
}

const SUPPORTED_VAULTS = (neutralVaults as NeutralVault[]).filter(
  (vault) => vault.type === 'Bundle' || vault.type === 'Drift',
)

const BUNDLE_VAULTS = SUPPORTED_VAULTS.filter(
  (vault): vault is NeutralVault & { type: 'Bundle' } =>
    vault.type === 'Bundle',
)
const DRIFT_VAULTS = SUPPORTED_VAULTS.filter(
  (vault): vault is NeutralVault & { type: 'Drift' } => vault.type === 'Drift',
)

const DRIFT_PROGRAM_IDS = Array.from(
  new Set([
    DRIFT_VAULT_PROGRAM_ID_DEFAULT,
    ...DRIFT_VAULTS.flatMap((vault) =>
      vault.driftProgramId ? [vault.driftProgramId] : [],
    ),
  ]),
)

export const PROGRAM_IDS = [
  BUNDLE_PROGRAM_ID_V1,
  BUNDLE_PROGRAM_ID_V2,
  ...DRIFT_PROGRAM_IDS,
]

const BUNDLE_DISC_USER_B64 = discriminatorBase64('UserBundleAccount')
const DRIFT_DISC_VAULT_DEPOSITOR_B64 = discriminatorBase64('VaultDepositor')
const DRIFT_DISC_VAULT_B64 = discriminatorBase64('Vault')
const BUNDLE_DISC_USER = Uint8Array.from(
  Buffer.from(BUNDLE_DISC_USER_B64, 'base64'),
)
const DRIFT_DISC_VAULT_DEPOSITOR = Uint8Array.from(
  Buffer.from(DRIFT_DISC_VAULT_DEPOSITOR_B64, 'base64'),
)

function discriminatorBase64(accountName: string) {
  return Buffer.from(
    createHash('sha256')
      .update(`account:${accountName}`)
      .digest()
      .subarray(0, 8),
  ).toString('base64')
}

function hasDiscriminator(data: Uint8Array, discB64: string): boolean {
  if (data.length < 8) return false
  return Buffer.from(data.subarray(0, 8)).toString('base64') === discB64
}

function readU64LE(data: Uint8Array, offset: number): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 8) return null
  return buf.readBigUInt64LE(offset)
}

function readSignedI64LE(data: Uint8Array, offset: number): bigint | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 8) return null
  return buf.readBigInt64LE(offset)
}

function readU128LE(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 16) return null
  let value = 0n
  for (let idx = 0; idx < 16; idx++) {
    value |= BigInt(data[offset + idx] ?? 0) << (BigInt(idx) * 8n)
  }
  return value
}

function readSignedI128LE(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 16) return null

  let value = 0n
  for (let idx = 0; idx < 16; idx++) {
    value |= BigInt(data[offset + idx] ?? 0) << (BigInt(idx) * 8n)
  }

  if ((data[offset + 15] ?? 0) & 0x80) {
    value -= 1n << 128n
  }

  return value
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buf = Buffer.from(data)
  if (buf.length < offset + 32) return null
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

function buildUsdValue(
  amountRaw: bigint,
  decimals: number,
  priceUsd?: number,
): string | undefined {
  if (priceUsd === undefined) return undefined
  if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return ((Number(amountRaw) / 10 ** decimals) * priceUsd).toString()
}

function buildLendingPosition(
  token: string,
  amountRaw: bigint,
  decimals: number,
  platformMeta: Record<string, unknown>,
  tokens: SolanaPlugins['tokens'],
): LendingDefiPosition {
  const tokenData = tokens.get(token)
  const priceUsd = tokenData?.priceUsd
  const usdValue = buildUsdValue(amountRaw, decimals, priceUsd)

  return {
    platformId: 'neutral',
    positionKind: 'lending',
    supplied: [
      {
        amount: {
          token,
          amount: amountRaw.toString(),
          decimals: decimals.toString(),
        },
        ...(priceUsd !== undefined && { priceUsd: priceUsd.toString() }),
        ...(usdValue !== undefined && { usdValue }),
      },
    ],
    ...(usdValue !== undefined && { usdValue }),
    meta: {
      neutral: platformMeta,
    },
  }
}

function deriveBundleUserPda(
  userAddress: string,
  vaultAddress: string,
  programId: string,
): string {
  return PublicKey.findProgramAddressSync(
    [
      BUNDLE_SEED_USER,
      new PublicKey(userAddress).toBuffer(),
      new PublicKey(vaultAddress).toBuffer(),
    ],
    new PublicKey(programId),
  )[0].toBase58()
}

function programCandidatesForBundle(vault: NeutralVault & { type: 'Bundle' }) {
  if (vault.bundleProgramId === BUNDLE_PROGRAM_ID_V1) {
    return [BUNDLE_PROGRAM_ID_V1, BUNDLE_PROGRAM_ID_V2]
  }

  if (vault.bundleProgramId === BUNDLE_PROGRAM_ID_V2) {
    return [BUNDLE_PROGRAM_ID_V2, BUNDLE_PROGRAM_ID_V1]
  }

  return [BUNDLE_PROGRAM_ID_V1, BUNDLE_PROGRAM_ID_V2]
}

function parseBundleUserAccount(data: Uint8Array) {
  // Anchor discriminator at [0..7]
  const shares = readU128LE(data, 48) ?? 0n
  const pendingDepositRaw = readU64LE(data, 64) ?? 0n
  const netDepositsRaw = readSignedI128LE(data, 152) ?? 0n

  return {
    shares,
    pendingDepositRaw,
    netDepositsRaw,
  }
}

function parseDriftDepositorAccount(data: Uint8Array) {
  // Anchor discriminator at [0..7]
  const vaultAddress = readPubkey(data, 8)
  const vaultShares = readU128LE(data, 104) ?? 0n
  const requestedWithdrawRaw = readU64LE(data, 136) ?? 0n
  const netDepositsRaw = readSignedI64LE(data, 160) ?? 0n

  if (!vaultAddress) return null

  return {
    vaultAddress,
    vaultShares,
    requestedWithdrawRaw,
    netDepositsRaw,
  }
}

function parseDriftVaultAccount(data: Uint8Array) {
  // Anchor discriminator at [0..7]
  const vaultAddress = readPubkey(data, 40)
  const totalShares = readU128LE(data, 280) ?? 0n

  if (!vaultAddress) return null

  return {
    vaultAddress,
    totalShares,
  }
}

export const neutralIntegration: SolanaIntegration = {
  platformId: 'neutral',

  getUserPositions: async function* (
    address: string,
    { tokens }: SolanaPlugins,
  ): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = tokens.get(token)
        if (tokenData === undefined) return undefined
        if (tokenData.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    const authority = new PublicKey(address)

    const requests: ProgramRequest[] = [
      {
        kind: 'getProgramAccounts' as const,
        programId: BUNDLE_PROGRAM_ID_V1,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: BUNDLE_DISC_USER_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: 8,
              bytes: authority.toBase58(),
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: BUNDLE_PROGRAM_ID_V2,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: BUNDLE_DISC_USER_B64,
              encoding: 'base64' as const,
            },
          },
          {
            memcmp: {
              offset: 8,
              bytes: authority.toBase58(),
            },
          },
        ],
      },
      ...DRIFT_PROGRAM_IDS.flatMap((programId) => [
        {
          kind: 'getProgramAccounts' as const,
          programId,
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: DRIFT_DISC_VAULT_DEPOSITOR_B64,
                encoding: 'base64' as const,
              },
            },
            {
              memcmp: {
                offset: DRIFT_DEPOSITOR_AUTHORITY_OFFSET,
                bytes: authority.toBase58(),
              },
            },
          ],
        },
        {
          kind: 'getProgramAccounts' as const,
          programId,
          cacheTtlMs: ONE_HOUR_IN_MS,
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: DRIFT_DISC_VAULT_B64,
                encoding: 'base64' as const,
              },
            },
          ],
        },
      ]),
    ]

    const accountsMap = yield requests

    const bundleUserAccountsByProgram = new Map<string, Set<string>>()
    const bundleUserDataByAddress = new Map<string, Uint8Array>()

    const driftDepositorAccountsByProgram = new Map<string, Uint8Array[]>()
    const driftVaultAccountsByProgram = new Map<
      string,
      Map<string, Uint8Array>
    >()

    for (const account of Object.values(accountsMap)) {
      if (!account.exists || account.data.length < 8) continue

      const programId = account.programAddress
      const data = account.data

      if (
        programId === BUNDLE_PROGRAM_ID_V1 ||
        programId === BUNDLE_PROGRAM_ID_V2
      ) {
        if (!hasDiscriminator(data, BUNDLE_DISC_USER_B64)) continue

        const addresses =
          bundleUserAccountsByProgram.get(programId) ?? new Set()
        addresses.add(account.address)
        bundleUserAccountsByProgram.set(programId, addresses)
        bundleUserDataByAddress.set(account.address, data)
        continue
      }

      if (DRIFT_PROGRAM_IDS.includes(programId)) {
        if (hasDiscriminator(data, DRIFT_DISC_VAULT_DEPOSITOR_B64)) {
          const depositors =
            driftDepositorAccountsByProgram.get(programId) ?? []
          depositors.push(data)
          driftDepositorAccountsByProgram.set(programId, depositors)
          continue
        }

        if (hasDiscriminator(data, DRIFT_DISC_VAULT_B64)) {
          const vaultMap =
            driftVaultAccountsByProgram.get(programId) ?? new Map()
          const parsed = parseDriftVaultAccount(data)
          if (parsed) vaultMap.set(parsed.vaultAddress, data)
          driftVaultAccountsByProgram.set(programId, vaultMap)
        }
      }
    }

    const positions: UserDefiPosition[] = []

    for (const vault of BUNDLE_VAULTS) {
      const candidates = programCandidatesForBundle(vault)

      let selectedProgram: string | undefined
      let selectedUserPda: string | undefined

      for (const programId of candidates) {
        const pda = deriveBundleUserPda(address, vault.vaultAddress, programId)
        const found = bundleUserAccountsByProgram.get(programId)?.has(pda)
        if (!found) continue

        selectedProgram = programId
        selectedUserPda = pda
        break
      }

      if (!selectedProgram || !selectedUserPda) continue

      const userData = bundleUserDataByAddress.get(selectedUserPda)
      if (!userData) continue

      const parsed = parseBundleUserAccount(userData)
      const principalRaw =
        parsed.netDepositsRaw > 0n ? parsed.netDepositsRaw : 0n
      const suppliedRaw = principalRaw + parsed.pendingDepositRaw

      if (suppliedRaw <= 0n && parsed.shares <= 0n) continue

      const tokenInfo = TOKEN_BY_SYMBOL[vault.depositToken]
      const token = tokenInfo?.token ?? vault.depositToken
      const decimals = tokenInfo?.decimals ?? 6

      positions.push(
        buildLendingPosition(
          token,
          suppliedRaw,
          decimals,
          {
            vaultId: vault.vaultId,
            vaultType: vault.type,
            vaultName: vault.name,
            subname: vault.subname,
            category: vault.category,
            vaultAddress: vault.vaultAddress,
            bundleProgramId: selectedProgram,
            source: 'bundle',
            accounting: {
              netDepositsRaw: parsed.netDepositsRaw.toString(),
              pendingDepositRaw: parsed.pendingDepositRaw.toString(),
              shares: parsed.shares.toString(),
            },
          },
          tokens,
        ),
      )
    }

    const driftVaultByAddress = new Map(
      DRIFT_VAULTS.map((vault) => [vault.vaultAddress, vault]),
    )

    for (const [
      programId,
      depositorAccounts,
    ] of driftDepositorAccountsByProgram) {
      const vaultAccounts =
        driftVaultAccountsByProgram.get(programId) ?? new Map()

      for (const depositorData of depositorAccounts) {
        const parsedDepositor = parseDriftDepositorAccount(depositorData)
        if (!parsedDepositor) continue

        const vault = driftVaultByAddress.get(parsedDepositor.vaultAddress)
        if (!vault) continue

        const vaultData = vaultAccounts.get(vault.vaultAddress)
        if (!vaultData) continue

        const parsedVault = parseDriftVaultAccount(vaultData)
        if (!parsedVault) continue

        const principalRaw =
          parsedDepositor.netDepositsRaw > 0n
            ? parsedDepositor.netDepositsRaw
            : 0n
        const suppliedRaw =
          parsedDepositor.requestedWithdrawRaw > 0n
            ? parsedDepositor.requestedWithdrawRaw
            : principalRaw

        if (suppliedRaw <= 0n && parsedDepositor.vaultShares <= 0n) continue

        const tokenInfo = TOKEN_BY_SYMBOL[vault.depositToken]
        const token = tokenInfo?.token ?? vault.depositToken
        const decimals = tokenInfo?.decimals ?? 6

        positions.push(
          buildLendingPosition(
            token,
            suppliedRaw > 0n ? suppliedRaw : 0n,
            decimals,
            {
              vaultId: vault.vaultId,
              vaultType: vault.type,
              vaultName: vault.name,
              subname: vault.subname,
              category: vault.category,
              vaultAddress: vault.vaultAddress,
              driftProgramId: programId,
              source: 'drift',
              valuationMode: 'accounting',
              accounting: {
                netDepositsRaw: parsedDepositor.netDepositsRaw.toString(),
                requestedWithdrawRaw:
                  parsedDepositor.requestedWithdrawRaw.toString(),
                balanceSource:
                  parsedDepositor.requestedWithdrawRaw > 0n
                    ? 'requested-withdraw-value'
                    : 'net-deposits',
                vaultShares: parsedDepositor.vaultShares.toString(),
                totalVaultShares: parsedVault.totalShares.toString(),
              },
            },
            tokens,
          ),
        )
      }
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: BUNDLE_PROGRAM_ID_V1,
      discriminator: BUNDLE_DISC_USER,
      ownerOffset: 8,
    },
    {
      programId: BUNDLE_PROGRAM_ID_V2,
      discriminator: BUNDLE_DISC_USER,
      ownerOffset: 8,
    },
    ...DRIFT_PROGRAM_IDS.map((programId) => ({
      programId,
      discriminator: DRIFT_DISC_VAULT_DEPOSITOR,
      ownerOffset: DRIFT_DEPOSITOR_AUTHORITY_OFFSET,
    })),
  ],
}

export default neutralIntegration
