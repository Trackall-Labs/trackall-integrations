import type { Platform } from '../types/platform'

const nirvanaPlatform = {
  id: 'nirvana' as const,
  networks: ['solana'],
  name: 'Nirvana',
  ticker: 'ANA',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://app.nirvana.finance/favicon.png',
  description: 'ANA staking and prANA rewards on Solana',
  tags: ['staking', 'governance'],
  defiLlamaId: 'nirvana',
  links: {
    website: 'https://app.nirvana.finance',
  },
} satisfies Platform

export default nirvanaPlatform
