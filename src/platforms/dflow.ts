import type { Platform } from '../types/platform'

const dflowPlatform = {
  id: 'dflow' as const,
  networks: ['solana'],
  name: 'DFlow',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://dflow.net/favicon/favicon.svg',
  description: 'DFlow prediction market outcome token positions on Solana',
  tags: ['defi'],
  defiLlamaId: 'dflow',
  links: {
    website: 'https://dflow.net/prediction',
    documentation: 'https://pond.dflow.net/introduction',
    github: 'https://github.com/DFlowProtocol',
  },
} satisfies Platform

export default dflowPlatform
