import { config } from 'dotenv'
import { Chain, PublicClient, createPublicClient, http } from 'viem'

config()

export default function (chain: Chain): PublicClient {
  const url = `https://rpc.snapshot.org/${chain.id}`

  return createPublicClient({
    chain,
    transport: http(url),
  })
}
