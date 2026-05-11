import type { Platform } from '../types/platform'

const ratexPlatform = {
  id: 'ratex' as const,
  networks: ['solana'],
  name: 'Rate-X',
  ticker: 'RTX',
  location: {
    latitude: 55.3781,
    longitude: -3.436,
  },
  image: 'https://icons.llama.fi/ratex-dex.jpg',
  description: "World's 1st Leveraged Yield Exchange on Solana",
  tags: [],
  links: {
    website: 'https://app.rate-x.io',
  },
  defiLlamaId: 'ratex-dex',
} satisfies Platform

export default ratexPlatform
