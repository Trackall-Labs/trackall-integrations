import type { Platform } from '../types/platform'

const validatorsPlatform = {
  id: 'validators' as const,
  networks: ['solana'],
  name: 'Native SOL Staking',
  ticker: 'SOL',
  image: 'https://solana.com/src/img/branding/solanaLogoMark.png',
  description: 'Native Solana validator stake account delegations.',
  tags: ['staking'],
  links: {
    website: 'https://solana.com/staking',
  },
} satisfies Platform

export default validatorsPlatform
