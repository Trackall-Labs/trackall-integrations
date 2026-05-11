import type { Platform } from '../types/platform'

const flashtradePlatform = {
  id: 'flashtrade' as const,
  networks: ['solana'],
  name: 'Flash Trade',
  ticker: 'FAF',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://www.flash.trade/favicon.ico',
  description: 'Perpetual futures exchange on Solana',
  tags: ['dex', 'defi'],
  links: {
    website: 'https://www.flash.trade',
    documentation: 'https://docs.flash.trade/flash-trade',
  },
} satisfies Platform

export default flashtradePlatform
