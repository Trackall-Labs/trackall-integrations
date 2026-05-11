import { PublicKey } from '@solana/web3.js'
import type {
  LendingBorrowedAsset,
  LendingDefiPosition,
  LendingSuppliedAsset,
  SolanaIntegration,
  SolanaPlugins,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const ILOOP_PROGRAM_ID = '3i8rGP3ex8cjs7YYWrQeE4nWizuaStsVNUXpRGtMbs3H'
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'

const OBLIGATION_DISCRIMINATOR = Buffer.from([
  168, 206, 141, 106, 88, 76, 172, 167,
])
const OBLIGATION_DISCRIMINATOR_B64 = OBLIGATION_DISCRIMINATOR.toString('base64')

const OBLIGATION_OWNER_OFFSET = 8
const OBLIGATION_LENDING_MARKET_OFFSET = 40
const OBLIGATION_TAG_OFFSET = 72
const OBLIGATION_DEPOSIT_RESERVE_OFFSET = 80
const OBLIGATION_DEPOSIT_AMOUNT_OFFSET = 112
const OBLIGATION_BORROW_RESERVE_OFFSET = 136
const OBLIGATION_BORROW_AMOUNT_OFFSET = 168

const RESERVE_LIQUIDITY_MINT_OFFSET = 40
const MINT_DECIMALS_OFFSET = 44

type IloopObligation = {
  address: string
  lendingMarket: string
  tag: bigint
  depositReserve: string
  depositAmount: bigint
  borrowReserve: string
  borrowAmount: bigint
}

type IloopReserve = {
  address: string
  liquidityMint: string
}

export const PROGRAM_IDS = [ILOOP_PROGRAM_ID] as const

function readPubkey(data: Uint8Array, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58()
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data).readBigUInt64LE(offset)
}

function isDefaultKey(address: string): boolean {
  return address === DEFAULT_PUBLIC_KEY
}

function hasObligationDiscriminator(data: Uint8Array): boolean {
  return Buffer.from(data).subarray(0, 8).equals(OBLIGATION_DISCRIMINATOR)
}

function parseObligation(
  address: string,
  data: Uint8Array,
): IloopObligation | null {
  if (data.length < OBLIGATION_BORROW_AMOUNT_OFFSET + 8) return null
  if (!hasObligationDiscriminator(data)) return null

  return {
    address,
    lendingMarket: readPubkey(data, OBLIGATION_LENDING_MARKET_OFFSET),
    tag: readU64LE(data, OBLIGATION_TAG_OFFSET),
    depositReserve: readPubkey(data, OBLIGATION_DEPOSIT_RESERVE_OFFSET),
    depositAmount: readU64LE(data, OBLIGATION_DEPOSIT_AMOUNT_OFFSET),
    borrowReserve: readPubkey(data, OBLIGATION_BORROW_RESERVE_OFFSET),
    borrowAmount: readU64LE(data, OBLIGATION_BORROW_AMOUNT_OFFSET),
  }
}

function parseReserve(address: string, data: Uint8Array): IloopReserve | null {
  if (data.length < RESERVE_LIQUIDITY_MINT_OFFSET + 32) return null

  return {
    address,
    liquidityMint: readPubkey(data, RESERVE_LIQUIDITY_MINT_OFFSET),
  }
}

function parseMintDecimals(data: Uint8Array): number | undefined {
  if (data.length <= MINT_DECIMALS_OFFSET) return undefined
  return data[MINT_DECIMALS_OFFSET]
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

function sumPositionUsdValue(
  supplied: LendingSuppliedAsset[],
  borrowed: LendingBorrowedAsset[],
): string | undefined {
  const suppliedValue = supplied.reduce(
    (sum, asset) => sum + Number(asset.usdValue ?? 0),
    0,
  )
  const borrowedValue = borrowed.reduce(
    (sum, asset) => sum + Number(asset.usdValue ?? 0),
    0,
  )

  if (!Number.isFinite(suppliedValue) || !Number.isFinite(borrowedValue)) {
    return undefined
  }

  if (
    supplied.every((asset) => asset.usdValue === undefined) &&
    borrowed.every((asset) => asset.usdValue === undefined)
  ) {
    return undefined
  }

  return (suppliedValue - borrowedValue).toString()
}

function buildSuppliedAsset(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  tokens: SolanaPlugins['tokens'],
): LendingSuppliedAsset {
  const token = tokens.get(mint)
  const usdValue = buildUsdValue(amountRaw, decimals, token?.priceUsd)

  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function buildBorrowedAsset(
  mint: string,
  amountRaw: bigint,
  decimals: number,
  tokens: SolanaPlugins['tokens'],
): LendingBorrowedAsset {
  const token = tokens.get(mint)
  const usdValue = buildUsdValue(amountRaw, decimals, token?.priceUsd)

  return {
    amount: {
      token: mint,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(token?.priceUsd !== undefined && {
      priceUsd: token.priceUsd.toString(),
    }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function mintDecimals(
  mint: string,
  tokens: SolanaPlugins['tokens'],
  mintDecimalsMap: Map<string, number>,
): number {
  return mintDecimalsMap.get(mint) ?? tokens.get(mint)?.decimals ?? 0
}

function tagLabel(tag: bigint): 'loop' | 'supply' {
  return tag === 1n ? 'supply' : 'loop'
}

export const iloopIntegration: SolanaIntegration = {
  platformId: 'iloop',

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

    const obligationMap = yield {
      kind: 'getProgramAccounts' as const,
      programId: ILOOP_PROGRAM_ID,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: OBLIGATION_DISCRIMINATOR_B64,
            encoding: 'base64',
          },
        },
        { memcmp: { offset: OBLIGATION_OWNER_OFFSET, bytes: address } },
      ],
    }

    const obligations: IloopObligation[] = []
    const uniqueReserveAddresses = new Set<string>()

    for (const [accountAddress, account] of Object.entries(obligationMap)) {
      if (!account.exists) continue

      const obligation = parseObligation(accountAddress, account.data)
      if (!obligation) continue

      obligations.push(obligation)

      if (!isDefaultKey(obligation.depositReserve)) {
        uniqueReserveAddresses.add(obligation.depositReserve)
      }
      if (!isDefaultKey(obligation.borrowReserve)) {
        uniqueReserveAddresses.add(obligation.borrowReserve)
      }
    }

    if (obligations.length === 0) return []

    const reserveAddresses = [...uniqueReserveAddresses]
    const reserveAccounts =
      reserveAddresses.length > 0 ? yield reserveAddresses : {}

    const reservesByAddress = new Map<string, IloopReserve>()
    const uniqueMints = new Set<string>()

    for (const reserveAddress of reserveAddresses) {
      const account = reserveAccounts[reserveAddress]
      if (!account?.exists) continue

      const reserve = parseReserve(reserveAddress, account.data)
      if (!reserve) continue

      reservesByAddress.set(reserveAddress, reserve)
      uniqueMints.add(reserve.liquidityMint)
    }

    const mintAddresses = [...uniqueMints]
    const mintAccounts = mintAddresses.length > 0 ? yield mintAddresses : {}
    const mintDecimalsMap = new Map<string, number>()

    for (const mint of mintAddresses) {
      const account = mintAccounts[mint]
      if (!account?.exists) continue

      const decimals = parseMintDecimals(account.data)
      if (decimals !== undefined) mintDecimalsMap.set(mint, decimals)
    }

    const positions: UserDefiPosition[] = []

    for (const obligation of obligations) {
      const supplied: LendingSuppliedAsset[] = []
      const borrowed: LendingBorrowedAsset[] = []

      if (
        obligation.depositAmount > 0n &&
        !isDefaultKey(obligation.depositReserve)
      ) {
        const reserve = reservesByAddress.get(obligation.depositReserve)
        if (reserve) {
          const decimals = mintDecimals(
            reserve.liquidityMint,
            tokens,
            mintDecimalsMap,
          )
          supplied.push(
            buildSuppliedAsset(
              reserve.liquidityMint,
              obligation.depositAmount,
              decimals,
              tokens,
            ),
          )
        }
      }

      if (
        obligation.borrowAmount > 0n &&
        !isDefaultKey(obligation.borrowReserve)
      ) {
        const reserve = reservesByAddress.get(obligation.borrowReserve)
        if (reserve) {
          const decimals = mintDecimals(
            reserve.liquidityMint,
            tokens,
            mintDecimalsMap,
          )
          borrowed.push(
            buildBorrowedAsset(
              reserve.liquidityMint,
              obligation.borrowAmount,
              decimals,
              tokens,
            ),
          )
        }
      }

      if (supplied.length === 0 && borrowed.length === 0) continue

      const position: LendingDefiPosition = {
        platformId: 'iloop',
        positionKind: 'lending',
        ...(supplied.length > 0 && { supplied }),
        ...(borrowed.length > 0 && { borrowed }),
        meta: {
          iloop: {
            obligation: obligation.address,
            lendingMarket: obligation.lendingMarket,
            tag: tagLabel(obligation.tag),
          },
        },
      }

      const usdValue = sumPositionUsdValue(supplied, borrowed)
      if (usdValue !== undefined) {
        position.usdValue = usdValue
      }

      positions.push(position)
    }

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: ILOOP_PROGRAM_ID,
      discriminator: OBLIGATION_DISCRIMINATOR,
      ownerOffset: OBLIGATION_OWNER_OFFSET,
    },
  ],
}

export default iloopIntegration
