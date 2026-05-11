import type { Platform } from '../types/platform'

const omnipairPlatform = {
  id: 'omnipair' as const,
  networks: ['solana'],
  name: 'Omnipair',
  ticker: 'OMFG',
  location: {
    latitude: 23.4241,
    longitude: 53.8478,
  },
  image: 'https://www.omnipair.fi/favicon-light/favicon-32x32.png',
  description: 'Omnipair AMM and lending markets on Solana',
  tags: ['dex', 'lending', 'defi'],
  links: {
    website: 'https://www.omnipair.fi',
    documentation: 'https://docs.omnipair.fi',
    github: 'https://github.com/omnipair',
    twitter: 'https://x.com/omnipair',
  },
} satisfies Platform

export default omnipairPlatform
