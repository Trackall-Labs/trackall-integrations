import { testIntegration } from '../../../test/solana-integration'
import { carrotIntegration, testAddress } from './index'

testIntegration(carrotIntegration, testAddress)
