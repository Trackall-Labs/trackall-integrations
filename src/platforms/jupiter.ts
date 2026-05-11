import type { Platform } from '../types/platform'

const jupiterLendPlatform = {
  id: 'jupiter' as const,
  networks: ['solana'],
  name: 'Jupiter Lend',
  ticker: 'JUP',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://jup.ag/favicon.ico',
  description:
    'Jupiter Lend earn — supply assets and track borrow positions on Solana',
  tags: ['lending'],
  links: {
    website: 'https://jup.ag/lend',
  },
  defiLlamaId: 'jupiter-lend',
} satisfies Platform

export default jupiterLendPlatform
