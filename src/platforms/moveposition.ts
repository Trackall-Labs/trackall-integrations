import type { Platform } from '../types/platform'

const movepositionPlatform = {
  id: 'moveposition' as const,
  networks: ['movement'],
  name: 'MovePosition',
  location: {
    latitude: 18.4207,
    longitude: -64.64,
  },
  image: 'https://app.moveposition.xyz/favicon.svg',
  description: 'Next-gen omnichain lending protocol',
  tags: ['lending'],
  links: {
    website: 'https://app.moveposition.xyz/',
    documentation: 'https://docs.moveposition.xyz/',
  },
} satisfies Platform

export default movepositionPlatform
