import { testIntegration } from '../../../test/solana-integration'
import { pancakeswapIntegration, testAddress } from '.'

testIntegration(pancakeswapIntegration, testAddress)
