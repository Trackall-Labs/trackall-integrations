import type { Platform } from '../types/platform'

const saberPlatform = {
  id: 'saber' as const,
  networks: ['solana'],
  name: 'Saber',
  ticker: 'SBR',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image: 'https://registry.saber.so/token-icons/sbr.svg',
  description: 'Saber StableSwap liquidity pools on Solana',
  tags: ['dex', 'defi', 'stablecoin'],
  defiLlamaId: 'saber',
  links: {
    website: 'https://app.saber.so/',
    documentation: 'https://docs.saber.so/',
    github: 'https://github.com/saber-hq/stable-swap',
  },
} satisfies Platform

export default saberPlatform
