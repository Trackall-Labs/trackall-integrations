import { testIntegration } from '../../../test/solana-integration'
import { sandglassIntegration, testAddress } from './index'

testIntegration(sandglassIntegration, testAddress, {
  timeoutMs: 120_000,
})
