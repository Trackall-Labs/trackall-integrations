import type { Platform } from '../types/platform'

const echelonPlatform = {
  id: 'echelon' as const,
  networks: ['movement'],
  name: 'Echelon',
  ticker: 'ELON',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://app.echelon.market/apple-touch-icon.png',
  description: 'Echelon non-custodial lending protocol on Movement',
  tags: ['lending'],
  links: {
    website: 'https://app.echelon.market/',
    documentation: 'https://docs.echelon.market/',
  },
} satisfies Platform

export default echelonPlatform
