import type { Platform } from '../types/platform'

const meteoraPlatform = {
  id: 'meteora' as const,
  networks: ['solana'],
  name: 'Meteora',
  ticker: 'MET',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://www.meteora.ag/icons/v2.svg',
  description: 'Meteora DLMM liquidity pools on Solana',
  tags: [],
  links: {
    website: 'https://app.meteora.ag',
  },
  defiLlamaId: 'meteora',
} satisfies Platform

export default meteoraPlatform
