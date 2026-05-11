import type { Platform } from '../types/platform'

const driftPlatform = {
  id: 'drift' as const,
  networks: ['solana'],
  name: 'Drift',
  ticker: 'DRIFT',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://docs.drift.trade/assets/favicon.svg',
  description: 'Drift spot margin deposits and borrows on Solana',
  tags: [],
  defiLlamaId: 'drift',
  links: {
    website: 'https://app.drift.trade',
  },
} satisfies Platform

export default driftPlatform
