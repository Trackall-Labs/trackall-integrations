import { PublicKey } from '@solana/web3.js'
import type {
  ConstantProductLiquidityDefiPosition,
  GetProgramAccountsRequest,
  PositionValue,
  ProgramRequest,
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
import { ONE_HOUR_IN_MS, ONE_MINUTE_IN_MS } from '../../../utils/solana'

const DIVVY_HOUSE_PROGRAM_ID = 'dvyFwAPniptQNb1ey4eM12L8iLHrzdiDsPPDndd6xAR'
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const HOUSE_DISCRIMINATOR_B58 = '4cEdzVs6LUe'
const HOUSE_ACCOUNT_SIZES = [294, 312] as const
const MINER_DISCRIMINATOR_B58 = 'eNfVyjwGziX'
const MINER_DISCRIMINATOR = Uint8Array.from([
  223, 113, 15, 54, 123, 122, 140, 100,
])
const MINER_ACCOUNT_SIZE = 96

const TOKEN_MINT_OFFSET = 0
const TOKEN_AMOUNT_OFFSET = 64

const HOUSE_MINT_OFFSET = 104
const HOUSE_CURRENCY_OFFSET = 136
const HOUSE_CURRENCY_DECIMALS_OFFSET = 168
const HOUSE_TOKEN_SUPPLY_OFFSET = 175
const HOUSE_LIQUIDITY_OFFSET = 183

const REWARDER_HOUSE_OFFSET = 8
const MINER_REWARDER_OFFSET = 9
const MINER_AUTHORITY_OFFSET = 41
const MINER_AMOUNT_OFFSET = 73

const MINT_DECIMALS_OFFSET = 44

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  DIVVY_HOUSE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
] as const

type HouseInfo = {
  address: string
  houseMint: string
  currencyMint: string
  currencyDecimals: number
  houseTokenSupply: bigint
  liquidity: bigint
}

type MinerInfo = {
  rewarder: string
  amount: bigint
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null
  try {
    return new PublicKey(data.slice(offset, offset + 32)).toBase58()
  } catch {
    return null
  }
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null
  return Buffer.from(data).readBigUInt64LE(offset)
}

function parseHouse(account: SolanaAccount): HouseInfo | null {
  if (account.data.length <= HOUSE_CURRENCY_DECIMALS_OFFSET) return null

  const houseMint = readPubkey(account.data, HOUSE_MINT_OFFSET)
  const currencyMint = readPubkey(account.data, HOUSE_CURRENCY_OFFSET)
  const houseTokenSupply = readU64(account.data, HOUSE_TOKEN_SUPPLY_OFFSET)
  const liquidity = readU64(account.data, HOUSE_LIQUIDITY_OFFSET)
  if (
    !houseMint ||
    !currencyMint ||
    houseTokenSupply === null ||
    liquidity === null
  )
    return null

  return {
    address: account.address,
    houseMint,
    currencyMint,
    currencyDecimals: account.data[HOUSE_CURRENCY_DECIMALS_OFFSET] ?? 0,
    houseTokenSupply,
    liquidity,
  }
}

function toUsdValue(
  amount: bigint,
  decimals: number,
  priceUsd: number | undefined,
): string | undefined {
  if (priceUsd === undefined) return undefined
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return ((Number(amount) / 10 ** decimals) * priceUsd).toString()
}

function buildStakedAsset(
  token: string,
  amount: bigint,
  decimals: number,
  priceUsd: number | undefined,
): StakedAsset {
  const value: StakedAsset = {
    amount: {
      token,
      amount: amount.toString(),
      decimals: decimals.toString(),
    },
  }

  if (priceUsd !== undefined) {
    value.priceUsd = priceUsd.toString()
    const usdValue = toUsdValue(amount, decimals, priceUsd)
    if (usdValue !== undefined) value.usdValue = usdValue
  }

  return value
}

function buildPoolToken(
  token: string,
  amount: bigint,
  decimals: number,
  priceUsd: number | undefined,
): PositionValue {
  const value: PositionValue = {
    amount: {
      token,
      amount: amount.toString(),
      decimals: decimals.toString(),
    },
  }

  if (priceUsd !== undefined) {
    value.priceUsd = priceUsd.toString()
    const usdValue = toUsdValue(amount, decimals, priceUsd)
    if (usdValue !== undefined) value.usdValue = usdValue
  }

  return value
}

function getMintDecimals(
  account: SolanaAccount | undefined,
  fallback: number,
): number {
  if (!account) return fallback
  if (account.programAddress !== TOKEN_PROGRAM_ID) return fallback
  if (account.data.length <= MINT_DECIMALS_OFFSET) return fallback
  return account.data[MINT_DECIMALS_OFFSET] ?? fallback
}

export const divvyIntegration: SolanaIntegration = {
  platformId: 'divvy',

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

    const houseRequests: GetProgramAccountsRequest[] = HOUSE_ACCOUNT_SIZES.map(
      (dataSize) => ({
        kind: 'getProgramAccounts' as const,
        programId: DIVVY_HOUSE_PROGRAM_ID,
        cacheTtlMs: ONE_HOUR_IN_MS,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: HOUSE_DISCRIMINATOR_B58,
              encoding: 'base58',
            },
          },
          { dataSize },
        ],
      }),
    )
    const minerRequest: GetProgramAccountsRequest = {
      kind: 'getProgramAccounts',
      programId: DIVVY_HOUSE_PROGRAM_ID,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: MINER_DISCRIMINATOR_B58,
            encoding: 'base58',
          },
        },
        { dataSize: MINER_ACCOUNT_SIZE },
        {
          memcmp: {
            offset: MINER_AUTHORITY_OFFSET,
            bytes: address,
            encoding: 'base58',
          },
        },
      ],
    }
    const tokenRequests: ProgramRequest[] = [
      {
        kind: 'getTokenAccountsByOwner',
        owner: address,
        programId: TOKEN_PROGRAM_ID,
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
      {
        kind: 'getTokenAccountsByOwner',
        owner: address,
        programId: TOKEN_2022_PROGRAM_ID,
        cacheTtlMs: ONE_MINUTE_IN_MS,
      },
    ]

    const discoveryMap = yield [
      ...houseRequests,
      minerRequest,
      ...tokenRequests,
    ]

    const houses = Object.values(discoveryMap)
      .filter((account): account is SolanaAccount => account.exists)
      .filter((account) => account.programAddress === DIVVY_HOUSE_PROGRAM_ID)
      .map(parseHouse)
      .filter((house): house is HouseInfo => house !== null)

    if (houses.length === 0) return []

    const miners: MinerInfo[] = Object.values(discoveryMap)
      .filter((account): account is SolanaAccount => account.exists)
      .filter((account) => account.programAddress === DIVVY_HOUSE_PROGRAM_ID)
      .filter((account) => account.data.length === MINER_ACCOUNT_SIZE)
      .map((account) => {
        const rewarder = readPubkey(account.data, MINER_REWARDER_OFFSET)
        const amount = readU64(account.data, MINER_AMOUNT_OFFSET)
        if (!rewarder || amount === null || amount <= 0n) return null
        return { rewarder, amount }
      })
      .filter((miner): miner is MinerInfo => miner !== null)

    const tokenAccounts = discoveryMap

    const houseByAddress = new Map(
      houses.map((house) => [house.address, house]),
    )
    const houseByMint = new Map(houses.map((house) => [house.houseMint, house]))
    const balancesByMint = new Map<string, bigint>()

    for (const account of Object.values(tokenAccounts)) {
      if (!account.exists) continue

      if (
        account.programAddress !== TOKEN_PROGRAM_ID &&
        account.programAddress !== TOKEN_2022_PROGRAM_ID
      ) {
        continue
      }

      const mint = readPubkey(account.data, TOKEN_MINT_OFFSET)
      const amount = readU64(account.data, TOKEN_AMOUNT_OFFSET)

      if (!mint || amount === null || amount <= 0n) continue
      if (!houseByMint.has(mint)) continue

      const current = balancesByMint.get(mint) ?? 0n
      balancesByMint.set(mint, current + amount)
    }

    const relevantHouses = houses.filter((house) => {
      const balance = balancesByMint.get(house.houseMint)
      return balance !== undefined && balance > 0n
    })

    const uniqueRewarders = [...new Set(miners.map((miner) => miner.rewarder))]
    const uniqueMints = [...new Set(houses.map((house) => house.houseMint))]
    const enrichmentAddresses = [
      ...new Set([...uniqueRewarders, ...uniqueMints]),
    ]
    const enrichmentAccounts =
      enrichmentAddresses.length > 0 ? yield enrichmentAddresses : {}

    const rewarderHouseByAddress = new Map<string, string>()
    for (const rewarderAddress of uniqueRewarders) {
      const rewarder = enrichmentAccounts[rewarderAddress]
      if (!rewarder?.exists) continue
      if (rewarder.programAddress !== DIVVY_HOUSE_PROGRAM_ID) continue
      const houseAddress = readPubkey(rewarder.data, REWARDER_HOUSE_OFFSET)
      if (!houseAddress) continue
      rewarderHouseByAddress.set(rewarderAddress, houseAddress)
    }

    const stakedByHouseMint = new Map<
      string,
      {
        amount: bigint
        houseAddress: string
        currencyMint: string
        currencyDecimals: number
      }
    >()
    for (const miner of miners) {
      const houseAddress = rewarderHouseByAddress.get(miner.rewarder)
      if (!houseAddress) continue
      const house = houseByAddress.get(houseAddress)
      if (!house) continue

      const current = stakedByHouseMint.get(house.houseMint)
      if (current) {
        stakedByHouseMint.set(house.houseMint, {
          amount: current.amount + miner.amount,
          houseAddress,
          currencyMint: house.currencyMint,
          currencyDecimals: house.currencyDecimals,
        })
      } else {
        stakedByHouseMint.set(house.houseMint, {
          amount: miner.amount,
          houseAddress,
          currencyMint: house.currencyMint,
          currencyDecimals: house.currencyDecimals,
        })
      }
    }

    const positions: UserDefiPosition[] = []
    const liquidityByMint = new Map<
      string,
      { amount: bigint; decimals: number }
    >()

    for (const [houseMint, stakedInfo] of stakedByHouseMint.entries()) {
      if (stakedInfo.amount <= 0n) continue

      const mintAccount = enrichmentAccounts[houseMint]
      const mintDecimals =
        mintAccount?.exists === true
          ? getMintDecimals(mintAccount, stakedInfo.currencyDecimals)
          : stakedInfo.currencyDecimals

      const token = tokens.get(houseMint)
      const stakedValue = buildStakedAsset(
        houseMint,
        stakedInfo.amount,
        mintDecimals,
        token?.priceUsd,
      )

      positions.push({
        platformId: 'divvy',
        positionKind: 'staking',
        staked: [stakedValue],
        ...(stakedValue.usdValue !== undefined && {
          usdValue: stakedValue.usdValue,
        }),
        meta: {
          divvy: {
            houseAddress: stakedInfo.houseAddress,
            houseMint,
            currencyMint: stakedInfo.currencyMint,
            currencyDecimals: stakedInfo.currencyDecimals.toString(),
          },
        },
      } satisfies StakingDefiPosition)
    }

    for (const house of relevantHouses) {
      const amount = balancesByMint.get(house.houseMint)
      if (amount === undefined || amount <= 0n) continue

      if (house.houseTokenSupply > 0n && house.liquidity > 0n) {
        const underlying = (amount * house.liquidity) / house.houseTokenSupply
        if (underlying > 0n) {
          const current = liquidityByMint.get(house.currencyMint)
          if (current) {
            liquidityByMint.set(house.currencyMint, {
              amount: current.amount + underlying,
              decimals: current.decimals,
            })
          } else {
            liquidityByMint.set(house.currencyMint, {
              amount: underlying,
              decimals: house.currencyDecimals,
            })
          }
        }
      }
    }

    if (liquidityByMint.size > 0) {
      const poolTokens: PositionValue[] = [...liquidityByMint.entries()].map(
        ([mint, { amount, decimals }]) =>
          buildPoolToken(mint, amount, decimals, tokens.get(mint)?.priceUsd),
      )

      const usdValue = poolTokens
        .map((tokenValue) => tokenValue.usdValue)
        .filter((value): value is string => value !== undefined)
        .map(Number)
        .reduce<number | undefined>(
          (sum, value) => (sum === undefined ? value : sum + value),
          undefined,
        )

      const liquidityPosition: ConstantProductLiquidityDefiPosition = {
        platformId: 'divvy',
        positionKind: 'liquidity',
        liquidityModel: 'constant-product',
        poolTokens,
        poolAddress: 'divvy:house-liquidity',
        ...(usdValue !== undefined && Number.isFinite(usdValue)
          ? { usdValue: usdValue.toString() }
          : {}),
        meta: {
          divvy: {
            houseCount: relevantHouses.length.toString(),
          },
        },
      }

      positions.push(liquidityPosition)
    }

    positions.sort((left, right) => {
      const kindRank = (kind: UserDefiPosition['positionKind']) => {
        if (kind === 'staking') return 0
        if (kind === 'liquidity') return 1
        return 2
      }
      const rankDiff =
        kindRank(left.positionKind) - kindRank(right.positionKind)
      if (rankDiff !== 0) return rankDiff

      const leftHouse = String(left.meta?.divvy?.houseAddress ?? '')
      const rightHouse = String(right.meta?.divvy?.houseAddress ?? '')
      return leftHouse.localeCompare(rightHouse)
    })

    applyPositionsPctUsdValueChange24(tokenSource, positions)
    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: DIVVY_HOUSE_PROGRAM_ID,
      discriminator: MINER_DISCRIMINATOR,
      ownerOffset: MINER_AUTHORITY_OFFSET,
      dataSize: MINER_ACCOUNT_SIZE,
    },
  ],
}

export default divvyIntegration
