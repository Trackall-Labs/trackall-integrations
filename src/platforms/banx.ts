import type { Platform } from '../types/platform'

const banxPlatform = {
  id: 'banx' as const,
  networks: ['solana'],
  name: 'BANX',
  ticker: 'BANX',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://banx.gg/favicon.ico',
  description: 'NFT-backed lending and offer markets on Solana',
  tags: ['lending', 'nft'],
  links: {
    website: 'https://banx.gg',
  },
} satisfies Platform

export default banxPlatform
