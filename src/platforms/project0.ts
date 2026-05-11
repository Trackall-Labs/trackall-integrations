import type { Platform } from '../types/platform'

const project0Platform = {
  id: 'project0' as const,
  networks: ['solana'],
  name: 'Project 0',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image:
    'https://cdn.prod.website-files.com/68833aeb7ad4d7934f9c5fec/68c1632baf163875c13e167e_Project%200%20Favicon.png',
  description:
    'Permissionless yield and credit positions powered by Project 0 on Solana',
  tags: ['lending'],
  links: {
    website: 'https://0.xyz',
    documentation: 'https://docs.0.xyz',
    github: 'https://github.com/0dotxyz/marginfi-v2',
  },
} satisfies Platform

export default project0Platform
