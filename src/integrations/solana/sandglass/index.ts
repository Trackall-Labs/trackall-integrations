import { unpackMint } from '@solana/spl-token'
import type { AccountInfo } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import type {
  SolanaAccount,
  SolanaIntegration,
  SolanaPlugins,
  StakedAsset,
  StakingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

type SandglassAccountSnapshot = {
  accountAddress: string
  marketAccount: string
  stakePtAmount: bigint
  stakeYtAmount: bigint
  stakeLpAmount: bigint
}

type SandglassMarketSnapshot = {
  accountAddress: string
  endTime: bigint
  syMint: string
  ptMint: string
  ytMint: string
  lpMint: string
}

type SandglassStakeToken = 'pt' | 'yt' | 'lp'

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

const SANDGLASS_PROGRAM_ID = 'SANDsy8SBzwUE8Zio2mrYZYqL52Phr2WQb9DDKuXMVK'
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const SANDGLASS_ACCOUNT_SIZE = 416
const SANDGLASS_MARKET_ACCOUNT_OFFSET = 9
const SANDGLASS_USER_ADDRESS_OFFSET = 41
const SANDGLASS_STAKE_PT_AMOUNT_OFFSET = 121
const SANDGLASS_STAKE_YT_AMOUNT_OFFSET = 153
const SANDGLASS_STAKE_LP_AMOUNT_OFFSET = 185

const MARKET_ACCOUNT_SIZE = 1104
const MARKET_END_TIME_OFFSET = 223
const MARKET_SY_MINT_OFFSET = 527
const MARKET_PT_MINT_OFFSET = 559
const MARKET_YT_MINT_OFFSET = 591
const MARKET_LP_MINT_OFFSET = 623

export const PROGRAM_IDS = [SANDGLASS_PROGRAM_ID, TOKEN_PROGRAM_ID] as const

function readU64(data: Uint8Array, offset: number): bigint | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 8) return null
  return buffer.readBigUInt64LE(offset)
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  const buffer = Buffer.from(data)
  if (buffer.length < offset + 32) return null
  return new PublicKey(buffer.subarray(offset, offset + 32)).toBase58()
}

function decodeSandglassAccount(
  account: SolanaAccount,
): SandglassAccountSnapshot | null {
  if (account.data.length < SANDGLASS_ACCOUNT_SIZE) return null

  const marketAccount = readPubkey(
    account.data,
    SANDGLASS_MARKET_ACCOUNT_OFFSET,
  )
  const stakePtAmount = readU64(account.data, SANDGLASS_STAKE_PT_AMOUNT_OFFSET)
  const stakeYtAmount = readU64(account.data, SANDGLASS_STAKE_YT_AMOUNT_OFFSET)
  const stakeLpAmount = readU64(account.data, SANDGLASS_STAKE_LP_AMOUNT_OFFSET)

  if (
    marketAccount === null ||
    stakePtAmount === null ||
    stakeYtAmount === null ||
    stakeLpAmount === null
  ) {
    return null
  }

  return {
    accountAddress: account.address,
    marketAccount,
    stakePtAmount,
    stakeYtAmount,
    stakeLpAmount,
  }
}

function decodeMarketAccount(
  account: SolanaAccount,
): SandglassMarketSnapshot | null {
  if (account.data.length < MARKET_ACCOUNT_SIZE) return null

  const endTime = readU64(account.data, MARKET_END_TIME_OFFSET)
  const syMint = readPubkey(account.data, MARKET_SY_MINT_OFFSET)
  const ptMint = readPubkey(account.data, MARKET_PT_MINT_OFFSET)
  const ytMint = readPubkey(account.data, MARKET_YT_MINT_OFFSET)
  const lpMint = readPubkey(account.data, MARKET_LP_MINT_OFFSET)

  if (
    endTime === null ||
    syMint === null ||
    ptMint === null ||
    ytMint === null ||
    lpMint === null
  ) {
    return null
  }

  return {
    accountAddress: account.address,
    endTime,
    syMint,
    ptMint,
    ytMint,
    lpMint,
  }
}

function decodeMintDecimals(account: SolanaAccount): number | undefined {
  try {
    const mint = unpackMint(
      new PublicKey(account.address),
      {
        data: Buffer.from(account.data),
        owner: new PublicKey(account.programAddress),
        lamports: Number(account.lamports),
        executable: false,
      } satisfies AccountInfo<Buffer>,
      new PublicKey(account.programAddress),
    )

    return mint.decimals
  } catch {
    return undefined
  }
}

function toUsdValue(
  amountRaw: bigint,
  decimals: number,
  tokenPriceUsd?: number,
): string | undefined {
  if (tokenPriceUsd === undefined) return undefined
  if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return undefined

  return ((Number(amountRaw) / 10 ** decimals) * tokenPriceUsd).toString()
}

function buildStakedAsset(
  mintAddress: string,
  amountRaw: bigint,
  decimals: number,
  tokenPriceUsd?: number,
): StakedAsset {
  const usdValue = toUsdValue(amountRaw, decimals, tokenPriceUsd)

  return {
    amount: {
      token: mintAddress,
      amount: amountRaw.toString(),
      decimals: decimals.toString(),
    },
    ...(tokenPriceUsd !== undefined && { priceUsd: tokenPriceUsd.toString() }),
    ...(usdValue !== undefined && { usdValue }),
  }
}

function pushStakePosition(
  positions: UserDefiPosition[],
  params: {
    market: SandglassMarketSnapshot
    sandglassAccountAddress: string
    stakeToken: SandglassStakeToken
    tokenMint: string
    amountRaw: bigint
    decimals: number
    tokenPriceUsd: number | undefined
  },
) {
  if (params.amountRaw <= 0n) return

  const stakedAsset = buildStakedAsset(
    params.tokenMint,
    params.amountRaw,
    params.decimals,
    params.tokenPriceUsd,
  )

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const position: StakingDefiPosition = {
    platformId: 'sandglass',
    positionKind: 'staking',
    staked: [stakedAsset],
    ...(stakedAsset.usdValue !== undefined && {
      usdValue: stakedAsset.usdValue,
    }),
    meta: {
      sandglass: {
        sandglassAccount: params.sandglassAccountAddress,
        marketAccount: params.market.accountAddress,
        marketEndTime: params.market.endTime.toString(),
        marketEnded: params.market.endTime <= nowSeconds,
        stakeToken: params.stakeToken,
      },
    },
  }

  positions.push(position)
}

export const sandglassIntegration: SolanaIntegration = {
  platformId: 'sandglass',

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

    const sandglassAccountMap = yield {
      kind: 'getProgramAccounts' as const,
      programId: SANDGLASS_PROGRAM_ID,
      filters: [
        { dataSize: SANDGLASS_ACCOUNT_SIZE },
        {
          memcmp: {
            offset: SANDGLASS_USER_ADDRESS_OFFSET,
            bytes: address,
            encoding: 'base58' as const,
          },
        },
      ],
    }

    const sandglassAccounts = Object.values(sandglassAccountMap)
      .filter((account): account is SolanaAccount => account.exists)
      .filter((account) => account.programAddress === SANDGLASS_PROGRAM_ID)

    const userStakeSnapshots = sandglassAccounts
      .map((account) => decodeSandglassAccount(account))
      .filter(
        (account): account is SandglassAccountSnapshot => account !== null,
      )
      .filter(
        (account) =>
          account.stakePtAmount > 0n ||
          account.stakeYtAmount > 0n ||
          account.stakeLpAmount > 0n,
      )

    if (userStakeSnapshots.length === 0) return []

    const marketAddresses = [
      ...new Set(userStakeSnapshots.map((account) => account.marketAccount)),
    ]

    const marketAccountsMap =
      marketAddresses.length > 0 ? yield marketAddresses : {}
    const marketsByAddress = new Map<string, SandglassMarketSnapshot>()

    for (const marketAddress of marketAddresses) {
      const account = marketAccountsMap[marketAddress]
      if (!account?.exists) continue
      if (account.programAddress !== SANDGLASS_PROGRAM_ID) continue

      const decodedMarket = decodeMarketAccount(account)
      if (decodedMarket) marketsByAddress.set(marketAddress, decodedMarket)
    }

    const tokenMints = [
      ...new Set(
        [...marketsByAddress.values()].flatMap((market) => [
          market.ptMint,
          market.ytMint,
          market.lpMint,
        ]),
      ),
    ]

    const mintAccountsMap = tokenMints.length > 0 ? yield tokenMints : {}
    const mintDecimals = new Map<string, number>()

    for (const tokenMint of tokenMints) {
      const account = mintAccountsMap[tokenMint]
      if (!account?.exists) continue
      const decimals = decodeMintDecimals(account)
      if (decimals !== undefined) mintDecimals.set(tokenMint, decimals)
    }

    const result: UserDefiPosition[] = []

    for (const snapshot of userStakeSnapshots) {
      const market = marketsByAddress.get(snapshot.marketAccount)
      if (!market) continue

      const ptToken = tokens.get(market.ptMint)
      const ytToken = tokens.get(market.ytMint)
      const lpToken = tokens.get(market.lpMint)

      pushStakePosition(result, {
        market,
        sandglassAccountAddress: snapshot.accountAddress,
        stakeToken: 'pt',
        tokenMint: market.ptMint,
        amountRaw: snapshot.stakePtAmount,
        decimals: mintDecimals.get(market.ptMint) ?? ptToken?.decimals ?? 0,
        tokenPriceUsd: ptToken?.priceUsd,
      })

      pushStakePosition(result, {
        market,
        sandglassAccountAddress: snapshot.accountAddress,
        stakeToken: 'yt',
        tokenMint: market.ytMint,
        amountRaw: snapshot.stakeYtAmount,
        decimals: mintDecimals.get(market.ytMint) ?? ytToken?.decimals ?? 0,
        tokenPriceUsd: ytToken?.priceUsd,
      })

      pushStakePosition(result, {
        market,
        sandglassAccountAddress: snapshot.accountAddress,
        stakeToken: 'lp',
        tokenMint: market.lpMint,
        amountRaw: snapshot.stakeLpAmount,
        decimals: mintDecimals.get(market.lpMint) ?? lpToken?.decimals ?? 0,
        tokenPriceUsd: lpToken?.priceUsd,
      })
    }

    applyPositionsPctUsdValueChange24(tokenSource, result)

    return result
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: SANDGLASS_PROGRAM_ID,
      ownerOffset: SANDGLASS_USER_ADDRESS_OFFSET,
      dataSize: SANDGLASS_ACCOUNT_SIZE,
    },
  ],
}

export default sandglassIntegration
