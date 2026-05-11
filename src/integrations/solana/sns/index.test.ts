import { testIntegration } from '../../../test/solana-integration'
import { snsIntegration, testAddress } from './index'

testIntegration(snsIntegration, testAddress, {
  timeoutMs: 180_000,
})
