import type { Platform } from '../types/platform'

const luloPlatform = {
  id: 'lulo' as const,
  networks: ['solana'],
  name: 'Lulo',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://app.lulo.fi/favicon.ico',
  description: 'Lulo-routed yield positions and lending allocations on Solana',
  tags: ['lending'],
  links: {
    website: 'https://app.lulo.fi',
    documentation: 'https://docs.lulo.fi',
  },
} satisfies Platform

export default luloPlatform
