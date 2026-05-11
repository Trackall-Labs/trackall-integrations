import type { Platform } from '../types/platform'

const stabblePlatform = {
  id: 'stabble' as const,
  networks: ['solana'],
  name: 'Stabble',
  ticker: 'STB',
  location: {
    latitude: 23.4241,
    longitude: 53.8478,
  },
  image:
    'https://docs.stabble.org/~gitbook/image?url=https%3A%2F%2F2014698084-files.gitbook.io%2F%7E%2Ffiles%2Fv0%2Fb%2Fgitbook-x-prod.appspot.com%2Fo%2Fspaces%252Fm5kNQ3ZbkP5LC5mdEB3Q%252Ficon%252F5hAVvgb1mCjyNwIblH5c%252FPNG-Final%2520File-Branding-Logo-Stabble-Logomark-01.png%3Falt%3Dmedia%26token%3Deca14ed7-4198-46d1-89cd-cf52bfa8e69a&width=48&height=48&sign=9b71c7df&sv=2',
  description:
    'Stabble weighted and composable stable liquidity pools on Solana',
  tags: ['dex', 'defi'],
  defiLlamaId: 'stabble',
  links: {
    website: 'https://app.stabble.org/',
    documentation: 'https://docs.stabble.org/',
    github: 'https://github.com/stabbleorg',
  },
} satisfies Platform

export default stabblePlatform
