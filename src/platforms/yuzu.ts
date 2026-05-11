import type { Platform } from '../types/platform'

const yuzuPlatform = {
  id: 'yuzu' as const,
  networks: ['movement'],
  name: 'Yuzu',
  ticker: 'YUZU',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://www.yuzu.finance/fruit-logo.png',
  description: 'Yuzu CLMM on Movement',
  tags: [],
  links: {
    website: 'https://app.yuzu.finance',
  },
  defiLlamaId: 'yuzu',
} satisfies Platform

export default yuzuPlatform
