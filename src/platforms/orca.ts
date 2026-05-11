import type { Platform } from '../types/platform'

const orcaPlatform = {
  id: 'orca' as const,
  networks: ['solana'],
  name: 'Orca',
  ticker: 'ORCA',
  location: {
    latitude: 36.2048,
    longitude: 138.2529,
  },
  image:
    'https://mintcdn.com/orca-ccf67c1f/K618mEucxJ6w73gh/logo/orca-logo.png?fit=max&auto=format&n=K618mEucxJ6w73gh&q=85&s=cec26ca4b233cefabd14c26dff7de6cb',
  description: 'Orca Whirlpools concentrated liquidity pools on Solana',
  tags: ['dex', 'defi'],
  defiLlamaId: 'orca',
  links: {
    website: 'https://www.orca.so',
    documentation: 'https://docs.orca.so/developers/overview',
    github: 'https://github.com/orca-so/whirlpools',
  },
} satisfies Platform

export default orcaPlatform
