import type { Platform } from '../types/platform'

const tramplinPlatform = {
  id: 'tramplin' as const,
  networks: ['solana'],
  name: 'Tramplin',
  location: {
    latitude: 19.3133,
    longitude: -81.2546,
  },
  image: 'https://cdn.tramplin.io/tramplin-logo.png',
  description:
    'Tramplin premium staking rewards protocol on top of delegated Solana stake',
  tags: ['staking'],
  links: {
    website: 'https://tramplin.io',
    documentation: 'https://blog.tramplin.io',
    twitter: 'https://x.com/Tramplin_io',
    discord: 'https://discord.gg/tramplin',
  },
} satisfies Platform

export default tramplinPlatform
