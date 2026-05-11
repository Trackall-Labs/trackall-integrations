import type { Aptos } from '@aptos-labs/ts-sdk'
import type { PlatformId } from '../platforms/index'
import type { AptosTokenPlugin } from '../plugin/aptos/tokens'
import type { UserDefiPosition } from './position'

export type AptosAddress = string

export interface AptosResource {
  type: string
  data: unknown
}

export type AptosAccountsMap = Record<AptosAddress, AptosResource[]>

export interface AptosPlugins {
  client: Aptos
  tokens: AptosTokenPlugin
}

export interface AptosIntegration {
  /** Platform identifier. */
  platformId: PlatformId
  /** Get the total value locked (TVL) of the integration. */
  getTvl?: (plugins: AptosPlugins) => Promise<string>
  /** Get the volume of the integration. */
  getVolume?: (plugins: AptosPlugins) => Promise<string>
  /** Get the number of daily active users of the integration. */
  getDailyActiveUsers?: (plugins: AptosPlugins) => Promise<string>
  /** Get the user positions of the integration. */
  getUserPositions?: (
    address: string,
    plugins: AptosPlugins,
  ) => Promise<UserDefiPosition[]>
}
