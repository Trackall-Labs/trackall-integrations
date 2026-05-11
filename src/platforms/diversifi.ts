import type { Platform } from '../types/platform'

const diversifiPlatform = {
  id: 'diversifi' as const,
  networks: ['solana'],
  name: 'DiversiFi',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://app.diversifi.trade/favicon-32x32.png',
  description: 'Auto-rebalanced crypto index baskets on Solana',
  tags: ['defi'],
  links: {
    website: 'https://app.diversifi.trade',
  },
} satisfies Platform

export default diversifiPlatform
