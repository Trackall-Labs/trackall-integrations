import type { Platform } from '../types/platform'

const mosaicPlatform = {
  id: 'mosaic' as const,
  networks: ['movement'],
  name: 'Mosaic',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://mosaic.ag/mosaic/favicon.svg',
  description: 'Mosaic AMM liquidity and LP farming on Movement',
  tags: ['dex'],
  links: {
    website: 'https://app.mosaic.ag/',
    documentation: 'https://docs.mosaic.ag/products/liquidity-protocol',
  },
} satisfies Platform

export default mosaicPlatform
