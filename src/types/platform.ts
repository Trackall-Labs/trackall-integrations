import type { PlatformTag } from './platformTag'

export interface PlatformLocation {
  /** Headquarters or project-base latitude in decimal degrees. */
  latitude: number
  /** Headquarters or project-base longitude in decimal degrees. */
  longitude: number
}

export interface PlatformLinks {
  /** Expected format: absolute URL (https://...). */
  website?: string
  /** Expected format: absolute Discord invite or server URL. */
  discord?: string
  /** Expected format: Telegram username URL or channel link (https://t.me/...). */
  telegram?: string
  /** Expected format: absolute Twitter/X profile URL (https://x.com/...). */
  twitter?: string
  /** Expected format: absolute GitHub repository/profile URL. */
  github?: string
  /** Expected format: absolute Medium profile/publication URL. */
  medium?: string
  /** Expected format: absolute documentation URL (usually docs subdomain or docs site). */
  documentation?: string
}

export interface Platform {
  /** Unique platform identifier (string). */
  id: string
  /** Networks the platform is deployed on. */
  networks: string[]
  /** Display name of the platform. */
  name: string
  /** Optional platform ticker/symbol for UI display or lookup. */
  ticker?: string
  /** Optional headquarters or project-base coordinates in decimal degrees. */
  location?: PlatformLocation
  /** Expected format: URL of the platform logo/image (https://... with image extension). */
  image: string
  /** Short text description suitable for UI display. */
  description: string
  /** DefiLlama platform identifier used for cross-service lookup. */
  defiLlamaId?: string
  /** Platform tags, constrained by the shared PlatformTag string union. */
  tags: PlatformTag[]
  /** Related platform links. Each field expects a URL string. */
  links?: PlatformLinks
}
