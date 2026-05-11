import { testIntegration } from '../../../test/solana-integration'
import { nirvanaIntegration, testAddress } from './index'

testIntegration(nirvanaIntegration, testAddress)
