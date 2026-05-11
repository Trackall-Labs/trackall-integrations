import type { Platform } from '../types/platform'

const orePlatform = {
  id: 'ore' as const,
  networks: ['solana'],
  name: 'ORE',
  ticker: 'ORE',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://ore.supply/assets/logo-black.svg',
  description: 'Proof-of-work mining and staking protocol on Solana',
  tags: [],
  links: {
    website: 'https://ore.fyi',
  },
  defiLlamaId: 'ore-protocol',
} satisfies Platform

export default orePlatform
