import type { Platform } from '../types/platform'

const raydiumPlatform = {
  id: 'raydium' as const,
  networks: ['solana'],
  name: 'Raydium',
  ticker: 'RAY',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image:
    'https://img.raydium.io/icon/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R.png',
  description: 'Raydium CLMM and CP swap pools on Solana',
  tags: [],
  links: {
    website: 'https://raydium.io',
  },
  defiLlamaId: 'raydium',
} satisfies Platform

export default raydiumPlatform
