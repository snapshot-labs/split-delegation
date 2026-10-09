import { createPublicClient, getAddress, http } from 'viem'

import { prisma } from './store'

import { mainnet, gnosis } from './chains'
import { ChainConfig } from './chains/types'

import { blockDataToRows } from './fns/logToRows'

const V1_ADDRESS = getAddress('0x469788fe6e9e9681c6ebf3bf78e7fd26fc015446')
const V2_ADDRESS = getAddress('0xde1e8a7e184babd9f0e3af18f40634e9ed6f0905')

const POLL_INTERVAL = 10_000

async function run() {
  const checkpoints = await prisma.checkpoint.findMany()
  const cpMainnet = checkpoints.find((c) => c.chainId == 1)
  const countMainnet = await prisma.delegationEvent.count({
    where: { chainId: 1 },
  })
  const cpGnosis = checkpoints.find((c) => c.chainId == 100)
  const countGnosis = await prisma.delegationEvent.count({
    where: { chainId: 100 },
  })
  if (cpMainnet) {
    console.log(`[Mainnet] ${countMainnet} logs @ ${cpMainnet.blockNumber} `)
  }
  if (cpGnosis) {
    console.log(`[Gnosis ] ${countGnosis} logs @ ${cpGnosis.blockNumber} `)
  }

  await Promise.all([mainnet, gnosis].map(sync))
}

/*
 * Reads the registry logs with eth_getLogs, in ranges the RPC accepts, up to
 * `finality` blocks behind the head, and checkpoints the last block read
 */
async function sync(chain: ChainConfig) {
  const { chainId } = chain
  const client = createPublicClient({ transport: http(chain.rpc) })

  const checkpoint = await prisma.checkpoint.findUnique({ where: { chainId } })
  let from = checkpoint
    ? checkpoint.blockNumber + 1
    : chain.deploymentBlocks.DelegateRegistryV1
  let head = 0

  console.log(`Starting processor for ${chain.shortName} at block ${from}`)

  while (true) {
    try {
      if (from > head) {
        head = Number(await client.getBlockNumber()) - chain.finality
      }
      if (from > head) {
        await sleep(POLL_INTERVAL)
        continue
      }

      const to = Math.min(from + chain.blockRange - 1, head)
      const [logs, { hash }] = await Promise.all([
        client.getLogs({
          address: [V1_ADDRESS, V2_ADDRESS],
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        }),
        client.getBlock({ blockNumber: BigInt(to) }),
      ])

      // the logs by block, timestamped with the blockTimestamp the RPC adds to
      // each log, or from the block header when it is missing or 0x0 (which
      // rpc.snapshot.org sometimes returns)
      const blocks = await Promise.all(
        [...new Set(logs.map((log) => log.blockNumber))].map(
          async (blockNumber) => {
            const blockLogs = logs.filter(
              (log) => log.blockNumber == blockNumber
            )
            const { blockTimestamp } = blockLogs[0] as {
              blockTimestamp?: string
            }
            const timestamp =
              Number(blockTimestamp) ||
              Number((await client.getBlock({ blockNumber })).timestamp)
            return {
              header: {
                height: Number(blockNumber),
                timestamp: timestamp * 1000,
              },
              logs: blockLogs,
            }
          }
        )
      )

      const rows = blockDataToRows(chainId, blocks)
      await prisma.delegationEvent.createMany({
        data: rows,
        skipDuplicates: true,
      })
      await prisma.checkpoint.upsert({
        create: { chainId, blockNumber: to, hash },
        update: { blockNumber: to, hash },
        where: { chainId },
      })
      if (rows.length > 0) {
        console.log(`[${chain.shortName}] ${rows.length} logs @ ${to}`)
      }

      from = to + 1
    } catch (e) {
      console.error(`[${chain.shortName}]`, e)
      await sleep(POLL_INTERVAL)
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

run()
