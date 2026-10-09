import { ChainConfig } from './types'

export default {
  rpc: process.env.ETH_RPC_URL || 'https://rpc.snapshot.org/1',
  chainId: 1,
  shortName: 'eth',
  finality: 10,
  blockRange: 1000,

  deploymentBlocks: {
    DelegateRegistryV1: 11225329,
    DelegateRegistryV2: 18413076,
  },
} satisfies ChainConfig
