import type { Platform } from '../types/platform'

const sandglassPlatform = {
  id: 'sandglass' as const,
  networks: ['solana'],
  name: 'Sandglass',
  location: {
    latitude: 36.2048,
    longitude: 138.2529,
  },
  image: 'https://sandglass.so/sandglass-image.png',
  description: 'Yield trading markets with PT, YT, and LP positions on Solana',
  tags: ['defi', 'staking'],
  links: {
    website: 'https://sandglass.so/',
    twitter: 'https://x.com/sandglass_so',
    discord: 'https://discord.gg/jSNe84QZ67',
    medium:
      'https://medium.com/@lifinity.io/introducing-sandglass-a-yield-trading-protocol-on-solana-9b5ee5b33aff',
  },
} satisfies Platform

export default sandglassPlatform
