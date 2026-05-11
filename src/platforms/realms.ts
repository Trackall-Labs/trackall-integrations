import type { Platform } from '../types/platform'

const realmsPlatform = {
  id: 'realms' as const,
  networks: ['solana'],
  name: 'Realms',
  image: 'https://v2.realms.today/favicons/apple-icon.png',
  description:
    'DAO governance memberships and voting power deposits on Solana via Realms',
  tags: ['governance'],
  links: {
    website: 'https://v2.realms.today',
    documentation: 'https://docs.realms.today',
  },
} satisfies Platform

export default realmsPlatform
