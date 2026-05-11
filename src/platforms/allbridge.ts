import type { Platform } from '../types/platform'

const allbridgePlatform = {
  id: 'allbridge' as const,
  networks: ['solana'],
  name: 'Allbridge Core',
  ticker: 'ABR0',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://allbridge.io/assets/icons/core.svg',
  description: 'Allbridge Core stablecoin liquidity pools on Solana',
  tags: ['bridge', 'defi'],
  links: {
    website: 'https://allbridge.io',
    documentation: 'https://docs-core.allbridge.io',
    github: 'https://github.com/allbridge-io/allbridge-core-js-sdk',
  },
} satisfies Platform

export default allbridgePlatform
