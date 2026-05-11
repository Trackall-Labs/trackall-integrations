import type { Platform } from '../types/platform'

const manifestPlatform = {
  id: 'manifest' as const,
  networks: ['solana'],
  name: 'Manifest',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://manifest.trade/apple-touch-icon.png',
  description: 'Manifest spot orderbook markets on Solana',
  tags: ['dex', 'defi'],
  links: {
    website: 'https://manifest.trade',
    github: 'https://github.com/Bonasa-Tech/manifest',
  },
} satisfies Platform

export default manifestPlatform
