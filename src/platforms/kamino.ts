import type { Platform } from '../types/platform'

const kaminoPlatform = {
  id: 'kamino' as const,
  networks: ['solana'],
  name: 'Kamino',
  ticker: 'KMNO',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://kamino.com/apple-touch-icon.png',
  description: 'Kamino Lending obligations and Earn vault shares on Solana',
  tags: ['lending', 'staking'],
  defiLlamaId: 'kamino',
  links: {
    website: 'https://app.kamino.finance',
  },
} satisfies Platform

export default kaminoPlatform
