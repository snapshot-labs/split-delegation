export interface ChainConfig {
  rpc: string
  chainId: ChainId
  shortName: string
  finality: number
  /** Most blocks the RPC accepts in one eth_getLogs call */
  blockRange: number

  deploymentBlocks: {
    DelegateRegistryV1: number
    DelegateRegistryV2: number
  }
}

export type ChainId = 1 | 100
