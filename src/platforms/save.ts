import type { Platform } from '../types/platform'

const savePlatform = {
  id: 'save' as const,
  networks: ['solana'],
  name: 'Save',
  ticker: 'SAVE',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://d22m18a7q7pf6d.cloudfront.net/favicon-32x32.png',
  description: 'Save lending markets: supplied collateral and borrowed assets',
  tags: ['lending'],
  defiLlamaId: 'save',
  links: {
    website: 'https://save.finance',
    documentation: 'https://docs.save.finance',
    github: 'https://github.com/solendprotocol/solana-program-library',
  },
} satisfies Platform

export default savePlatform
