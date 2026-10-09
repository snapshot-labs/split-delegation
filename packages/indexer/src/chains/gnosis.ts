import { ChainConfig } from './types'

export default {
  rpc: process.env.GNOSIS_RPC_URL || 'https://rpc.snapshot.org/100',
  chainId: 100,
  shortName: 'gno',
  finality: 20,
  blockRange: 10000,

  deploymentBlocks: {
    DelegateRegistryV1: 20274491,
    DelegateRegistryV2: 26474496,
  },
} satisfies ChainConfig
