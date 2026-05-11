import { testIntegration } from '../../../test/solana-integration'
import { pythStakingIntegration, testAddress } from '.'

testIntegration(pythStakingIntegration, testAddress, {
  timeoutMs: 180_000,
})
