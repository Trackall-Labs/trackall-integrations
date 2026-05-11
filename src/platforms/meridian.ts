import type { Platform } from '../types/platform'

const meridianPlatform = {
  id: 'meridian' as const,
  networks: ['movement'],
  name: 'Meridian',
  location: {
    latitude: 22.3193,
    longitude: 114.1694,
  },
  image: 'https://app.meridian.money/apple-touch-icon.png',
  description: 'Meridian lending and liquidity on Movement',
  tags: ['dex', 'lending'],
  links: {
    website: 'https://app.meridian.money/',
  },
} satisfies Platform

export default meridianPlatform
