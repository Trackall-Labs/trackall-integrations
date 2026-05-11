import { testIntegration } from '../../../test/solana-integration'
import { flashtradeIntegration, testAddress } from './index'

testIntegration(flashtradeIntegration, testAddress)
