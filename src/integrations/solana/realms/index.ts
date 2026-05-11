import { unpackMint } from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type {
  GetProgramAccountsRequest,
  MaybeSolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  StakingDefiPosition,
  TokenData,
  UserDefiPosition,
  UserPositionsPlan,
  // UsersFilter,
  // UsersFilterPlan,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  '4ruGZqLoPVKX27Qm91Qjsqt5AzCtLrhmjKT8ubwHiVZu',
  'A7kmu2kUcnQwAVn8B4znQmGJeUrsJ1WEhYVMtmiBLkEr',
  'AEauWRrpn9Cs6GXujzdp1YhMmv2288kBt3SdEcPYEerr',
  'AVoAYTs36yB5izAaBkxRG67wL1AMwG3vo41hKtUSb8is',
  'DcG2PZTnj8s4Pnmp7xJswniCskckU5E6XsrKuyD7NYFK',
  'Di9ZVJeJrRZdQEWzAFYmfjukjR5dUQb7KMaDmv34rNJg',
  'GMnke6kxYvqoAXgbFGnu84QzvNHoqqTnijWSXYYTFQbB',
  'Ghope52FuF6HU3AAhJuAAyS2fiqbVhkAotb7YprL5tdS',
  'GoVERLMGbGF8kwAwhyNgF1BQ2uyQPawHCWbnFRmLZCf',
  'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw',
  'GovHgfDPyQ1GwazJTDY2avSVY8GGcpmCapmmCsymRaGe',
  'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs',
  'GqTPL6qRf5aUuqscLh8Rg2HTxPUXfhhAXDptTLhp1t2J',
  'J9uWvULFL47gtCPvgR3oN7W357iehn5WF2Vn9MJvcSxz',
  'JPGov2SBA6f7XSJF5R4Si5jEJekGiyrwP2m7gSEqLUs',
  'MGovW65tDhMMcpEmsegpsdgvzb6zUwGsNjhXFxRAnjd',
  'dgov7NC8iaumWw3k8TkmLDybvZBCmd1qwxgLAGAsWxf',
  'hgovkRU6Ghe1Qoyb54HdSLdqN7VtxaifBzRmh9jtd3S',
  'jdaoDN37BrVRvxuXSeyR7xE5Z9CAoQApexGrQJbnj6V',
  'jtogvBNH3WBSWDYD5FJfQP2ZxNTuf82zL8GkEhPeaJx',
] as const

const TOKEN_OWNER_RECORD_V1 = 2
const TOKEN_OWNER_RECORD_V2 = 17
// const TOKEN_OWNER_RECORD_V1_DISC = Uint8Array.from([TOKEN_OWNER_RECORD_V1])
// const TOKEN_OWNER_RECORD_V2_DISC = Uint8Array.from([TOKEN_OWNER_RECORD_V2])
const REALM_V1 = 1
const REALM_V2 = 16

const TOR_REALM_OFFSET = 1
const TOR_MINT_OFFSET = TOR_REALM_OFFSET + 32
const TOR_OWNER_OFFSET = TOR_MINT_OFFSET + 32
const TOR_DEPOSIT_AMOUNT_OFFSET = TOR_OWNER_OFFSET + 32
const TOR_UNRELINQUISHED_VOTES_OFFSET = TOR_DEPOSIT_AMOUNT_OFFSET + 8
const TOR_TOTAL_VOTES_OFFSET = TOR_UNRELINQUISHED_VOTES_OFFSET + 4
const TOR_OUTSTANDING_PROPOSALS_OFFSET = TOR_TOTAL_VOTES_OFFSET + 4
const TOR_VERSION_OFFSET = TOR_OUTSTANDING_PROPOSALS_OFFSET + 1
const TOR_RESERVED_OFFSET = TOR_VERSION_OFFSET + 1
const TOR_GOVERNANCE_DELEGATE_OFFSET = TOR_RESERVED_OFFSET + 6
const MIN_TOKEN_OWNER_RECORD_LENGTH = TOR_GOVERNANCE_DELEGATE_OFFSET + 1

const REALM_COMMUNITY_MINT_OFFSET = 1
const REALM_CONFIG_OFFSET = REALM_COMMUNITY_MINT_OFFSET + 32
const REALM_COUNCIL_MINT_OPTION_OFFSET = REALM_CONFIG_OFFSET + 25
const GOVERNANCE_PROGRAMS_PER_BATCH = 3
// const ONE_HOUR_IN_MS = 60 * 60 * 1000

const textDecoder = new TextDecoder()

type RealmRole = 'community' | 'council' | 'unknown'

type TokenOwnerRecordData = {
  address: string
  programId: string
  accountType: typeof TOKEN_OWNER_RECORD_V1 | typeof TOKEN_OWNER_RECORD_V2
  realm: string
  governingTokenMint: string
  governingTokenOwner: string
  governingTokenDepositAmount: bigint
  unrelinquishedVotesCount: number
  totalVotesCount: number
  outstandingProposalCount: number
  version: number
  governanceDelegate?: string
}

type RealmData = {
  address: string
  accountType: typeof REALM_V1 | typeof REALM_V2
  communityMint: string
  councilMint?: string
  name: string
}

type MintData = ReturnType<typeof unpackMint>

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  return new PublicKey(data.slice(offset, offset + 32)).toBase58()
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function readU32(data: Uint8Array, offset: number): number | null {
  if (data.length < offset + 4) return null
  return Buffer.from(data).readUInt32LE(offset)
}

function readU16(data: Uint8Array, offset: number): number | null {
  if (data.length < offset + 2) return null
  return Buffer.from(data).readUInt16LE(offset)
}

function readOptionPubkey(
  data: Uint8Array,
  offset: number,
): { value?: string; nextOffset: number } | null {
  if (data.length < offset + 1) return null

  const tag = data[offset]
  if (tag === 0) {
    return { nextOffset: offset + 1 }
  }

  if (tag !== 1 || data.length < offset + 33) return null

  return {
    value: new PublicKey(data.slice(offset + 1, offset + 33)).toBase58(),
    nextOffset: offset + 33,
  }
}

function decodeTokenOwnerRecord(
  address: string,
  programId: string,
  data: Uint8Array,
): TokenOwnerRecordData | null {
  const accountType = data[0]
  if (
    data.length < MIN_TOKEN_OWNER_RECORD_LENGTH ||
    (accountType !== TOKEN_OWNER_RECORD_V1 &&
      accountType !== TOKEN_OWNER_RECORD_V2)
  ) {
    return null
  }

  const realm = readPubkey(data, TOR_REALM_OFFSET)
  const governingTokenMint = readPubkey(data, TOR_MINT_OFFSET)
  const governingTokenOwner = readPubkey(data, TOR_OWNER_OFFSET)
  const governingTokenDepositAmount = readU64(data, TOR_DEPOSIT_AMOUNT_OFFSET)
  const unrelinquishedVotesCount = readU32(
    data,
    TOR_UNRELINQUISHED_VOTES_OFFSET,
  )
  const totalVotesCount = readU32(data, TOR_TOTAL_VOTES_OFFSET)
  const governanceDelegate = readOptionPubkey(
    data,
    TOR_GOVERNANCE_DELEGATE_OFFSET,
  )

  if (
    !realm ||
    !governingTokenMint ||
    !governingTokenOwner ||
    governingTokenDepositAmount === null ||
    unrelinquishedVotesCount === null ||
    totalVotesCount === null ||
    !governanceDelegate
  ) {
    return null
  }

  return {
    address,
    programId,
    accountType,
    realm,
    governingTokenMint,
    governingTokenOwner,
    governingTokenDepositAmount,
    unrelinquishedVotesCount,
    totalVotesCount,
    outstandingProposalCount: data[TOR_OUTSTANDING_PROPOSALS_OFFSET] ?? 0,
    version: data[TOR_VERSION_OFFSET] ?? 0,
    ...(governanceDelegate.value && {
      governanceDelegate: governanceDelegate.value,
    }),
  }
}

function decodeRealm(address: string, data: Uint8Array): RealmData | null {
  const accountType = data[0]
  if (accountType !== REALM_V1 && accountType !== REALM_V2) return null

  const communityMint = readPubkey(data, REALM_COMMUNITY_MINT_OFFSET)
  if (!communityMint) return null

  const councilMint = readOptionPubkey(data, REALM_COUNCIL_MINT_OPTION_OFFSET)
  if (!councilMint) return null

  let offset = councilMint.nextOffset + 6
  const votingProposalCount = readU16(data, offset)
  if (votingProposalCount === null) return null
  offset += 2

  const authority = readOptionPubkey(data, offset)
  if (!authority) return null
  offset = authority.nextOffset

  const nameLength = readU32(data, offset)
  if (nameLength === null) return null
  offset += 4

  if (data.length < offset + nameLength) return null
  const name = textDecoder.decode(data.slice(offset, offset + nameLength))

  return {
    address,
    accountType,
    communityMint,
    name,
    ...(councilMint.value && { councilMint: councilMint.value }),
  }
}

function toAccountInfo(
  account: MaybeSolanaAccount | undefined,
): AccountInfo<Buffer> | null {
  if (!account?.exists) return null

  return {
    data: Buffer.from(account.data),
    owner: new PublicKey(account.programAddress),
    lamports: Number(account.lamports),
    executable: false,
    rentEpoch: 0,
  }
}

function decodeMint(
  address: string,
  account: MaybeSolanaAccount | undefined,
): MintData | null {
  const accountInfo = toAccountInfo(account)
  if (!accountInfo) return null

  try {
    return unpackMint(new PublicKey(address), accountInfo, accountInfo.owner)
  } catch {
    return null
  }
}

function buildTokenOwnerRecordRequest(
  programId: string,
  accountType: typeof TOKEN_OWNER_RECORD_V1 | typeof TOKEN_OWNER_RECORD_V2,
  owner: string,
): GetProgramAccountsRequest {
  return {
    kind: 'getProgramAccounts',
    programId,
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from([accountType]).toString('base64'),
          encoding: 'base64',
        },
      },
      {
        memcmp: {
          offset: TOR_OWNER_OFFSET,
          bytes: owner,
        },
      },
    ],
  }
}

// function buildRealmDiscoveryRequest(
//   programId: string,
//   accountType: typeof REALM_V1 | typeof REALM_V2,
// ): GetProgramAccountsRequest {
//   return {
//     kind: 'getProgramAccounts',
//     programId,
//     cacheTtlMs: ONE_HOUR_IN_MS,
//     filters: [
//       {
//         memcmp: {
//           offset: 0,
//           bytes: Buffer.from([accountType]).toString('base64'),
//           encoding: 'base64',
//         },
//       },
//     ],
//   }
// }

// function buildTokenOwnerRecordUsersFiltersForPrograms(
//   programIds: Iterable<string>,
// ): UsersFilter[] {
//   return Array.from(new Set(programIds)).flatMap((programId) => [
//     {
//       programId,
//       discriminator: TOKEN_OWNER_RECORD_V1_DISC,
//       ownerOffset: TOR_OWNER_OFFSET,
//     },
//     {
//       programId,
//       discriminator: TOKEN_OWNER_RECORD_V2_DISC,
//       ownerOffset: TOR_OWNER_OFFSET,
//     },
//   ])
// }

function buildUsdValue(
  depositAmount: bigint,
  token: TokenData | undefined,
): string | undefined {
  if (token?.priceUsd === undefined) return undefined
  return (
    (Number(depositAmount) / 10 ** token.decimals) *
    token.priceUsd
  ).toString()
}

function classifyRealmRole(
  governingTokenMint: string,
  realm: RealmData | undefined,
): RealmRole {
  if (!realm) return 'unknown'
  if (governingTokenMint === realm.communityMint) return 'community'
  if (governingTokenMint === realm.councilMint) return 'council'
  return 'unknown'
}

export const realmsIntegration: SolanaIntegration = {
  platformId: 'realms',

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

    const owner = new PublicKey(address).toBase58()
    const tokenOwnerRecords: TokenOwnerRecordData[] = []

    for (
      let index = 0;
      index < PROGRAM_IDS.length;
      index += GOVERNANCE_PROGRAMS_PER_BATCH
    ) {
      const programIds = PROGRAM_IDS.slice(
        index,
        index + GOVERNANCE_PROGRAMS_PER_BATCH,
      )
      const tokenOwnerRecordsMap = yield programIds.flatMap((programId) => [
        buildTokenOwnerRecordRequest(programId, TOKEN_OWNER_RECORD_V1, owner),
        buildTokenOwnerRecordRequest(programId, TOKEN_OWNER_RECORD_V2, owner),
      ])

      tokenOwnerRecords.push(
        ...Object.values(tokenOwnerRecordsMap).flatMap((account) => {
          if (!account?.exists) return []

          const decoded = decodeTokenOwnerRecord(
            account.address,
            account.programAddress,
            account.data,
          )

          if (
            !decoded ||
            decoded.governingTokenOwner !== owner ||
            decoded.governingTokenDepositAmount <= 0n
          ) {
            return []
          }

          return [decoded]
        }),
      )
    }

    tokenOwnerRecords.sort((left, right) =>
      left.realm.localeCompare(right.realm),
    )

    if (tokenOwnerRecords.length === 0) return []

    const realmAddresses = [
      ...new Set(tokenOwnerRecords.map((record) => record.realm)),
    ]
    const mintAddresses = [
      ...new Set(tokenOwnerRecords.map((record) => record.governingTokenMint)),
    ]
    const metadataMap = yield [...realmAddresses, ...mintAddresses]

    const realms = new Map<string, RealmData>()
    for (const address of realmAddresses) {
      const account = metadataMap[address]
      if (!account?.exists) continue
      const decoded = decodeRealm(address, account.data)
      if (decoded) realms.set(address, decoded)
    }

    const mintDecimals = new Map<string, number>()
    for (const address of mintAddresses) {
      const mint = decodeMint(address, metadataMap[address])
      if (mint) mintDecimals.set(address, mint.decimals)
    }

    const positions: UserDefiPosition[] = tokenOwnerRecords.map((record) => {
      const token = tokens.get(record.governingTokenMint)
      const decimals =
        mintDecimals.get(record.governingTokenMint) ?? token?.decimals ?? 0
      const usdValue = buildUsdValue(record.governingTokenDepositAmount, token)
      const realm = realms.get(record.realm)
      const role = classifyRealmRole(record.governingTokenMint, realm)

      const position: StakingDefiPosition = {
        platformId: 'realms',
        positionKind: 'staking',
        staked: [
          {
            amount: {
              token: record.governingTokenMint,
              amount: record.governingTokenDepositAmount.toString(),
              decimals: decimals.toString(),
            },
            ...(token?.priceUsd !== undefined && {
              priceUsd: token.priceUsd.toString(),
            }),
            ...(usdValue !== undefined && { usdValue }),
          },
        ],
        meta: {
          realm: {
            address: record.realm,
            name: realm?.name ?? record.realm,
            role,
            programId: record.programId,
            tokenOwnerRecord: record.address,
            accountType: record.accountType,
            version: record.version,
            unrelinquishedVotesCount: record.unrelinquishedVotesCount,
            totalVotesCount: record.totalVotesCount,
            outstandingProposalCount: record.outstandingProposalCount,
            ...(record.governanceDelegate && {
              governanceDelegate: record.governanceDelegate,
            }),
          },
        },
        ...(usdValue !== undefined && { usdValue }),
      }

      return position
    })

    positions.sort((left, right) => {
      const leftName = String(
        left.meta?.realm?.name ?? left.meta?.realm?.address ?? '',
      )
      const rightName = String(
        right.meta?.realm?.name ?? right.meta?.realm?.address ?? '',
      )
      return leftName.localeCompare(rightName)
    })

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  // getUsersFilter: async function* (): UsersFilterPlan {
  //   const realmAccounts = yield PROGRAM_IDS.flatMap((programId) => [
  //     buildRealmDiscoveryRequest(programId, REALM_V1),
  //     buildRealmDiscoveryRequest(programId, REALM_V2),
  //   ])

  //   const discoveredProgramIds = new Set<string>()
  //   for (const account of Object.values(realmAccounts)) {
  //     if (!account.exists) continue
  //     const decoded = decodeRealm(account.address, account.data)
  //     if (!decoded) continue
  //     discoveredProgramIds.add(account.programAddress)
  //   }

  //   if (discoveredProgramIds.size === 0) {
  //     return buildTokenOwnerRecordUsersFiltersForPrograms(PROGRAM_IDS)
  //   }

  //   return buildTokenOwnerRecordUsersFiltersForPrograms(discoveredProgramIds)
  // },
}

export default realmsIntegration
