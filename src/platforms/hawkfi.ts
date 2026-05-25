import type { Platform } from '../types/platform'

const hawkfiPlatform = {
  id: 'hawkfi' as const,
  networks: ['solana'],
  name: 'HawkFi',
  location: {
    latitude: 1.3564,
    longitude: 103.8241,
  },
  image:
    'https://media.thegrid.id/70/7/172/id1761223287-yofTwDGNQzWuWUaALp4d4Q/image-1762950223.jpg',
  description: 'HawkFi automated liquidity positions on Solana',
  tags: ['defi'],
  defiLlamaId: 'hawkfi',
  links: {
    website: 'https://www.hawkfi.ag',
    documentation: 'https://hawkfi.gitbook.io/whitepaper',
  },
} satisfies Platform

export default hawkfiPlatform
