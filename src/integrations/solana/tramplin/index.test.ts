import { testIntegration } from '../../../test/solana-integration'
import { testAddress, tramplinIntegration } from './index'

testIntegration(tramplinIntegration, testAddress, {
  timeoutMs: 180_000,
})
