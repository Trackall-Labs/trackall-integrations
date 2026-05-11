import type { Platform } from '../types/platform'

const carrotPlatform = {
  id: 'carrot' as const,
  networks: ['solana'],
  name: 'Carrot',
  ticker: 'CRT',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://boost.deficarrot.com/android-chrome-512x512.png',
  description:
    'Carrot is a leveraged yield farming protocol for JLP, FLP.1, and ONyc on Solana.',
  tags: [],
  defiLlamaId: 'carrot',
  links: {
    website: 'https://boost.deficarrot.com',
  },
} satisfies Platform

export default carrotPlatform
