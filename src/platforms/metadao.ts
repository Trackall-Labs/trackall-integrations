import type { Platform } from '../types/platform'

const metadaoPlatform = {
  id: 'metadao' as const,
  networks: ['solana'],
  name: 'MetaDAO',
  ticker: 'META',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://docs.metadao.fi/images/logo.png',
  description:
    'MetaDAO launchpad commitments and claimable allocations on Solana',
  tags: ['defi', 'governance', 'staking'],
  defiLlamaId: 'metadao',
  links: {
    website: 'https://www.metadao.fi',
    documentation: 'https://docs.metadao.fi',
    github: 'https://github.com/metaDAOproject/programs',
  },
} satisfies Platform

export default metadaoPlatform
