import { CategoryOffer, NAME_OFFERS_ID, Offer, Tag } from '@bonfida/name-offers'
import {
  deserializeReverse,
  getReverseKeyFromDomainKey,
  NAME_PROGRAM_ID,
  ROOT_DOMAIN_ACCOUNT,
} from '@bonfida/spl-name-service'
import { PublicKey } from '@solana/web3.js'
import type {
  PositionValue,
  SolanaIntegration,
  SolanaPlugins,
  TradingDefiPosition,
  UserDefiPosition,
  UserPositionsPlan,
  UsersFilterSource,
} from '../../../types/index'
import { applyPositionsPctUsdValueChange24 } from '../../../utils/positionChange'

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_DECIMALS = 9

const ACTIVE_OFFER_TAG_B58 = '2'
const ACTIVE_OFFER_OWNER_OFFSET = 34

const CATEGORY_OFFER_TAG_B58 = 'C'
const CATEGORY_OFFER_OWNER_OFFSET = 50

export const testAddress = 'tEsT1vjsJeKHw9GH5HpnQszn2LWmjR6q1AVCDCj51nd'

export const PROGRAM_IDS = [
  NAME_OFFERS_ID.toBase58(),
  NAME_PROGRAM_ID.toBase58(),
] as const

function normalizeSolName(value: string): string {
  if (value.endsWith('.sol')) return value
  return `${value}.sol`
}

function buildValue(
  token: string,
  amount: bigint,
  decimals: number,
  plugins: SolanaPlugins,
): PositionValue {
  const tokenInfo = plugins.tokens.get(token)

  return {
    amount: {
      token,
      amount: amount.toString(),
      decimals: (tokenInfo?.decimals ?? decimals).toString(),
    },
    ...(tokenInfo?.priceUsd !== undefined && {
      priceUsd: tokenInfo.priceUsd.toString(),
    }),
  }
}

type ActiveOfferSource = {
  account: string
  nameAccount: string
  quoteMint: string
  offerAmount: bigint
  escrow: string
}

type CategoryOfferSource = {
  account: string
  category: string
  nbDomains: bigint
  solPrice: bigint
  createdAt: bigint
}

function decodeActiveOffer(account: {
  address: string
  data: Uint8Array
}): ActiveOfferSource | null {
  try {
    const decoded = Offer.deserialize(Buffer.from(account.data))
    return {
      account: account.address,
      nameAccount: decoded.nameAccount.toBase58(),
      quoteMint: decoded.quoteMint.toBase58(),
      offerAmount: decoded.offerAmount,
      escrow: decoded.escrow.toBase58(),
    }
  } catch {
    return null
  }
}

function decodeCategoryOffer(account: {
  address: string
  data: Uint8Array
}): CategoryOfferSource | null {
  try {
    const decoded = CategoryOffer.deserialize(Buffer.from(account.data))
    return {
      account: account.address,
      category: decoded.category.toBase58(),
      nbDomains: decoded.nbDomains,
      solPrice: decoded.solPrice,
      createdAt: decoded.createdAt,
    }
  } catch {
    return null
  }
}

export const snsIntegration: SolanaIntegration = {
  platformId: 'sns',

  getUserPositions: async function* (
    address: string,
    plugins: SolanaPlugins,
  ): UserPositionsPlan {
    const tokenSource = {
      get(token: string): { pctPriceChange24h?: number } | undefined {
        const tokenData = plugins.tokens.get(token)
        if (tokenData === undefined) return undefined
        if (tokenData.pctPriceChange24h === undefined) return undefined
        return { pctPriceChange24h: tokenData.pctPriceChange24h }
      },
    }

    try {
      new PublicKey(address)
    } catch {
      return []
    }

    const discoveredOfferAccounts = yield [
      {
        kind: 'getProgramAccounts' as const,
        programId: NAME_OFFERS_ID.toBase58(),
        filters: [
          { memcmp: { offset: 0, bytes: ACTIVE_OFFER_TAG_B58 } },
          {
            memcmp: {
              offset: ACTIVE_OFFER_OWNER_OFFSET,
              bytes: address,
              encoding: 'base58',
            },
          },
        ],
      },
      {
        kind: 'getProgramAccounts' as const,
        programId: NAME_OFFERS_ID.toBase58(),
        filters: [
          { memcmp: { offset: 0, bytes: CATEGORY_OFFER_TAG_B58 } },
          {
            memcmp: {
              offset: CATEGORY_OFFER_OWNER_OFFSET,
              bytes: address,
              encoding: 'base58',
            },
          },
        ],
      },
    ]

    const activeOffers: ActiveOfferSource[] = []
    const categoryOffers: CategoryOfferSource[] = []

    for (const account of Object.values(discoveredOfferAccounts)) {
      if (!account.exists) continue
      if (account.programAddress !== NAME_OFFERS_ID.toBase58()) continue
      if (account.data.length === 0) continue

      if (account.data[0] === Tag.ActiveOffer) {
        const decoded = decodeActiveOffer(account)
        if (!decoded) continue
        activeOffers.push(decoded)
        continue
      }

      if (account.data[0] === Tag.CategoryOffer) {
        const decoded = decodeCategoryOffer(account)
        if (!decoded) continue
        categoryOffers.push(decoded)
      }
    }

    const nameAccounts = [
      ...new Set(activeOffers.map((offer) => offer.nameAccount)),
    ]
    const reverseByNameAccount = new Map<string, string>()
    const reverseLookupKeysByNameAccount = new Map<string, string[]>()

    if (nameAccounts.length > 0) {
      for (const nameAccount of nameAccounts) {
        const domainKey = new PublicKey(nameAccount)
        const reverseKeyDefault =
          getReverseKeyFromDomainKey(domainKey).toBase58()
        const reverseKeyRoot = getReverseKeyFromDomainKey(
          domainKey,
          ROOT_DOMAIN_ACCOUNT,
        ).toBase58()

        reverseLookupKeysByNameAccount.set(
          nameAccount,
          reverseKeyDefault === reverseKeyRoot
            ? [reverseKeyDefault]
            : [reverseKeyDefault, reverseKeyRoot],
        )
      }

      const reverseLookupKeys = [
        ...new Set([...reverseLookupKeysByNameAccount.values()].flat()),
      ]
      const reverseAccounts = yield reverseLookupKeys

      for (const [
        nameAccount,
        reverseLookupKeysForName,
      ] of reverseLookupKeysByNameAccount) {
        for (const reverseLookupKey of reverseLookupKeysForName) {
          const reverseAccount = reverseAccounts[reverseLookupKey]
          if (!reverseAccount?.exists) continue
          if (reverseAccount.programAddress !== NAME_PROGRAM_ID.toBase58())
            continue

          try {
            const value = deserializeReverse(
              Buffer.from(reverseAccount.data),
              true,
            )
            if (value.length === 0) continue
            reverseByNameAccount.set(nameAccount, normalizeSolName(value))
            break
          } catch {}
        }
      }
    }

    const positions: UserDefiPosition[] = []

    for (const offer of activeOffers) {
      const deposited = [
        buildValue(offer.quoteMint, offer.offerAmount, 0, plugins),
      ]

      positions.push({
        platformId: 'sns',
        positionKind: 'trading',
        marketType: 'spot',
        marginEnabled: false,
        deposited,
        meta: {
          sns: {
            offerType: 'unsolicited',
            offerAccount: offer.account,
            nameAccount: offer.nameAccount,
            name: reverseByNameAccount.get(offer.nameAccount),
            quoteMint: offer.quoteMint,
            escrow: offer.escrow,
          },
        },
      } satisfies TradingDefiPosition)
    }

    for (const offer of categoryOffers) {
      const amount = offer.solPrice * offer.nbDomains
      const deposited = [
        buildValue(WRAPPED_SOL_MINT, amount, SOL_DECIMALS, plugins),
      ]

      positions.push({
        platformId: 'sns',
        positionKind: 'trading',
        marketType: 'spot',
        marginEnabled: false,
        deposited,
        meta: {
          sns: {
            offerType: 'category',
            offerAccount: offer.account,
            category: offer.category,
            nbDomains: offer.nbDomains.toString(),
            solPrice: offer.solPrice.toString(),
            createdAt: offer.createdAt.toString(),
          },
        },
      } satisfies TradingDefiPosition)
    }

    positions.sort((left, right) => {
      const leftAddress = left.meta?.sns?.offerAccount
      const rightAddress = right.meta?.sns?.offerAccount
      if (typeof leftAddress !== 'string' || typeof rightAddress !== 'string') {
        return 0
      }
      return leftAddress.localeCompare(rightAddress)
    })

    applyPositionsPctUsdValueChange24(tokenSource, positions)

    return positions
  },

  getUsersFilter: (): UsersFilterSource => [
    {
      programId: NAME_OFFERS_ID.toBase58(),
      discriminator: Uint8Array.from([Tag.ActiveOffer]),
      ownerOffset: ACTIVE_OFFER_OWNER_OFFSET,
    },
    {
      programId: NAME_OFFERS_ID.toBase58(),
      discriminator: Uint8Array.from([Tag.CategoryOffer]),
      ownerOffset: CATEGORY_OFFER_OWNER_OFFSET,
    },
  ],
}

export default snsIntegration
