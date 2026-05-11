import type { Platform } from '../types/platform'

const zeusPlatform = {
  id: 'zeus' as const,
  networks: ['solana'],
  name: 'Zeus',
  ticker: 'ZEUS',
  location: {
    latitude: 23.6978,
    longitude: 120.9605,
  },
  image: 'https://app.zeusnetwork.xyz/apple-icon.png',
  description: 'Zeus BTC staking strategies on Solana',
  tags: ['staking'],
  links: {
    website: 'https://zeusnetwork.xyz',
  },
} satisfies Platform

export default zeusPlatform
