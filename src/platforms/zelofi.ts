import type { Platform } from '../types/platform'

const zelofiPlatform = {
  id: 'zelofi' as const,
  networks: ['solana'],
  name: 'Zelo Finance',
  location: {
    latitude: 1.3521,
    longitude: 103.8198,
  },
  image: 'https://www.zelofi.io/favicon.ico',
  description: 'Solana lossless lottery savings protocol',
  tags: ['staking', 'defi'],
  links: {
    website: 'https://www.zelofi.io/dapp',
    documentation: 'https://blocksmithlabs-1.gitbook.io/zelo-docs',
    twitter: 'https://x.com/BlocksmithLabs',
    discord: 'https://discord.gg/blocksmithlabs',
  },
} satisfies Platform

export default zelofiPlatform
