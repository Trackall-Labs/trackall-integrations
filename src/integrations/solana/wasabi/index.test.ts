import { testIntegration } from '../../../test/solana-integration'
import { testAddress, wasabiIntegration } from '.'

testIntegration(wasabiIntegration, testAddress)
