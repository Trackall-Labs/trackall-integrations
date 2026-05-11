import { testIntegration } from '../../../test/solana-integration'
import { banxIntegration, testAddress } from './index'

testIntegration(banxIntegration, testAddress)
