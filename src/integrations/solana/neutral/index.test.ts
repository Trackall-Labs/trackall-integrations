import { testIntegration } from '../../../test/solana-integration'
import { neutralIntegration, testAddress } from '.'

testIntegration(neutralIntegration, testAddress, { timeoutMs: 120_000 })
