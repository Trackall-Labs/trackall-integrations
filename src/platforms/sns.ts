import type { Platform } from '../types/platform'

const snsPlatform = {
  id: 'sns' as const,
  networks: ['solana'],
  name: 'SNS',
  ticker: 'SNS',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://www.sns.id/favicon-light.png',
  description: 'Solana Name Service domain offers marketplace',
  tags: ['defi', 'nft'],
  links: {
    website: 'https://sns.id',
  },
} satisfies Platform

export default snsPlatform
