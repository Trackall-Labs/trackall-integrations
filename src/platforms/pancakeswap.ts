import type { Platform } from '../types/platform'

const pancakeswapPlatform = {
  id: 'pancakeswap' as const,
  networks: ['solana'],
  name: 'PancakeSwap',
  ticker: 'CAKE',
  location: {
    latitude: 35.8617,
    longitude: 104.1954,
  },
  image: 'https://icons.llama.fi/pancakeswap-amm-v3.jpg',
  description: 'PancakeSwap V3 concentrated liquidity pools on Solana',
  tags: ['dex', 'defi'],
  defiLlamaId: 'pancakeswap-amm-v3',
  links: {
    website: 'https://pancakeswap.finance/swap?chain=sol',
    documentation:
      'https://docs.pancakeswap.finance/welcome-to-pancakeswap/how-to-guides/get-started-sol/solana-faq',
    github: 'https://github.com/pancakeswap/pancake-frontend',
  },
} satisfies Platform

export default pancakeswapPlatform
