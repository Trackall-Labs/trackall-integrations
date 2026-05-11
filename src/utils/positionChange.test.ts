import { describe, expect, it } from 'bun:test'
import type { UserDefiPosition } from '../types/position'
import {
  applyPositionPctUsdValueChange24,
  applyPositionsPctUsdValueChange24,
  computePositionPctUsdValueChange24,
  type TokenPriceSource,
} from './positionChange'

function createTokenSource(changes: Record<string, number>): TokenPriceSource {
  return {
    get(token: string) {
      const pctPriceChange24h = changes[token]
      if (pctPriceChange24h === undefined) return undefined
      return { pctPriceChange24h }
    },
  }
}

describe('positionChange', () => {
  it('computes net exposure for lending using negative borrowed weight by default', () => {
    const position: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'lending',
      supplied: [
        {
          amount: { token: 'SUP_A', amount: '100', decimals: '6' },
          usdValue: '100',
        },
        {
          amount: { token: 'SUP_B', amount: '50', decimals: '6' },
          usdValue: '50',
        },
      ],
      borrowed: [
        {
          amount: { token: 'BORROW_A', amount: '40', decimals: '6' },
          usdValue: '40',
        },
      ],
      rewards: [
        {
          amount: { token: 'REWARD', amount: '10', decimals: '6' },
          usdValue: '10',
        },
      ],
    }

    const tokenSource = createTokenSource({
      SUP_A: 10,
      SUP_B: -20,
      BORROW_A: 5,
      REWARD: 30,
    })

    const result = computePositionPctUsdValueChange24(tokenSource, position)
    expect(Number(result)).toBeCloseTo(0.8333333333333334, 12)
  })

  it('respects borrowedWeight override', () => {
    const position: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'lending',
      supplied: [
        {
          amount: { token: 'SUP_A', amount: '100', decimals: '6' },
          usdValue: '100',
        },
      ],
      borrowed: [
        {
          amount: { token: 'BORROW_A', amount: '50', decimals: '6' },
          usdValue: '50',
        },
      ],
    }

    const tokenSource = createTokenSource({
      SUP_A: 10,
      BORROW_A: 4,
    })

    const result = computePositionPctUsdValueChange24(tokenSource, position, {
      borrowedWeight: 1,
    })
    expect(Number(result)).toBeCloseTo(8, 12)
  })

  it('covers all trading token fields', () => {
    const position: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'trading',
      marketType: 'perp',
      marginEnabled: true,
      deposited: [
        {
          amount: { token: 'A', amount: '1', decimals: '6' },
          usdValue: '100',
        },
      ],
      buyOrders: [
        {
          side: 'buy',
          selling: {
            amount: { token: 'B', amount: '1', decimals: '6' },
            usdValue: '40',
          },
          buying: {
            amount: { token: 'C', amount: '1', decimals: '6' },
            usdValue: '20',
          },
        },
      ],
      sellOrders: [
        {
          side: 'sell',
          selling: {
            amount: { token: 'D', amount: '1', decimals: '6' },
            usdValue: '30',
          },
          buying: {
            amount: { token: 'E', amount: '1', decimals: '6' },
            usdValue: '10',
          },
        },
      ],
      positions: [
        {
          size: {
            amount: { token: 'F', amount: '1', decimals: '6' },
            usdValue: '50',
          },
          collateral: [
            {
              amount: { token: 'G', amount: '1', decimals: '6' },
              usdValue: '25',
            },
          ],
        },
      ],
      rewards: [
        {
          amount: { token: 'H', amount: '1', decimals: '6' },
          usdValue: '15',
        },
      ],
    }

    const tokenSource = createTokenSource({
      A: 10,
      B: 20,
      C: -50,
      D: 5,
      E: 100,
      F: -10,
      G: 8,
      H: 4,
    })

    const result = computePositionPctUsdValueChange24(tokenSource, position)
    expect(Number(result)).toBeCloseTo(5.896551724137931, 12)
  })

  it('covers reward and vesting token fields including nested claimable/claimed', () => {
    const vestingPosition: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'vesting',
      vesting: [
        {
          amount: { token: 'VEST_MAIN', amount: '1', decimals: '6' },
          usdValue: '100',
          claimable: {
            amount: {
              token: 'VEST_CLAIMABLE_NESTED',
              amount: '1',
              decimals: '6',
            },
            usdValue: '20',
          },
          claimed: {
            amount: {
              token: 'VEST_CLAIMED_NESTED',
              amount: '1',
              decimals: '6',
            },
            usdValue: '5',
          },
        },
      ],
      claimable: [
        {
          amount: { token: 'VEST_CLAIMABLE_TOP', amount: '1', decimals: '6' },
          usdValue: '10',
        },
      ],
      claimed: [
        {
          amount: { token: 'VEST_CLAIMED_TOP', amount: '1', decimals: '6' },
          usdValue: '15',
        },
      ],
      rewards: [
        {
          amount: { token: 'VEST_REWARD', amount: '1', decimals: '6' },
          usdValue: '8',
        },
      ],
    }

    const rewardPosition: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'reward',
      claimable: [
        {
          amount: { token: 'REWARD_CLAIMABLE', amount: '1', decimals: '6' },
          usdValue: '25',
        },
      ],
      claimed: [
        {
          amount: { token: 'REWARD_CLAIMED', amount: '1', decimals: '6' },
          usdValue: '10',
        },
      ],
    }

    const tokenSource = createTokenSource({
      VEST_MAIN: 10,
      VEST_CLAIMABLE_NESTED: 5,
      VEST_CLAIMED_NESTED: -20,
      VEST_CLAIMABLE_TOP: 1,
      VEST_CLAIMED_TOP: 2,
      VEST_REWARD: 3,
      REWARD_CLAIMABLE: 12,
      REWARD_CLAIMED: -5,
    })

    const vestingResult = computePositionPctUsdValueChange24(
      tokenSource,
      vestingPosition,
    )
    expect(Number(vestingResult)).toBeCloseTo(6.734177215189873, 12)

    const rewardResult = computePositionPctUsdValueChange24(
      tokenSource,
      rewardPosition,
    )
    expect(Number(rewardResult)).toBeCloseTo(7.142857142857143, 12)
  })

  it('skips entries with missing usdValue, invalid usdValue, or missing token 24h change', () => {
    const position: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'staking',
      staked: [
        {
          amount: { token: 'VALID', amount: '1', decimals: '6' },
          usdValue: '20',
        },
        {
          amount: { token: 'MISSING_USD', amount: '1', decimals: '6' },
        },
        {
          amount: { token: 'INVALID_USD', amount: '1', decimals: '6' },
          usdValue: 'NaN',
        },
        {
          amount: { token: 'NO_CHANGE', amount: '1', decimals: '6' },
          usdValue: '50',
        },
      ],
    }

    const tokenSource = createTokenSource({
      VALID: 7,
    })

    const result = computePositionPctUsdValueChange24(tokenSource, position)
    expect(result).toBe('7')
  })

  it('applies computed value to single and multiple positions', () => {
    const tokenSource = createTokenSource({
      A: 10,
      B: 5,
    })

    const firstPosition: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'reward',
      claimable: [
        {
          amount: { token: 'A', amount: '1', decimals: '6' },
          usdValue: '10',
        },
      ],
    }

    const secondPosition: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'reward',
      claimable: [
        {
          amount: { token: 'B', amount: '1', decimals: '6' },
          usdValue: '10',
        },
      ],
    }

    applyPositionPctUsdValueChange24(tokenSource, firstPosition)
    expect(firstPosition.pctUsdValueChange24).toBe('10')

    applyPositionsPctUsdValueChange24(tokenSource, [
      firstPosition,
      secondPosition,
    ])
    expect(firstPosition.pctUsdValueChange24).toBe('10')
    expect(secondPosition.pctUsdValueChange24).toBe('5')
  })

  it('supports ignoredKeys filtering', () => {
    const position: UserDefiPosition = {
      platformId: 'test',
      positionKind: 'lending',
      supplied: [
        {
          amount: { token: 'SUP', amount: '1', decimals: '6' },
          usdValue: '100',
        },
      ],
      rewards: [
        {
          amount: { token: 'REWARD', amount: '1', decimals: '6' },
          usdValue: '100',
        },
      ],
    }
    const tokenSource = createTokenSource({
      SUP: 10,
      REWARD: 0,
    })

    const withoutFilter = computePositionPctUsdValueChange24(
      tokenSource,
      position,
    )
    expect(Number(withoutFilter)).toBeCloseTo(5, 12)

    const withFilter = computePositionPctUsdValueChange24(
      tokenSource,
      position,
      {
        ignoredKeys: ['rewards'],
      },
    )
    expect(withFilter).toBe('10')
  })
})
