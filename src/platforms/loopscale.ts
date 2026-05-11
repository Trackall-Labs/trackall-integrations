import type { Platform } from '../types/platform'

const loopscalePlatform = {
  id: 'loopscale' as const,
  networks: ['solana'],
  name: 'Loopscale',
  location: {
    latitude: 37.0902,
    longitude: -95.7129,
  },
  image:
    'https://bridgesplit-app.s3.us-east-1.amazonaws.com/logo/logo_new_blue.png',
  description:
    'Loopscale is a Solana lending marketplace for loans and vault deposits.',
  tags: ['lending'],
  links: {
    website: 'https://app.loopscale.com/lend',
    documentation: 'https://docs.loopscale.com/introduction/overview',
  },
} satisfies Platform

export default loopscalePlatform
