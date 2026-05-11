import { testIntegration } from '../../../test/solana-integration'
import { testAddress, zelofiIntegration } from './index'

testIntegration(zelofiIntegration, testAddress)
