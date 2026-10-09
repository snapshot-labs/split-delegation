import { createServer } from 'node:http'
import {
  BaseError,
  BlockNotFoundError,
  createPublicClient,
  getAddress,
  http,
  HttpRequestError,
  TimeoutError,
} from 'viem'

import { prisma } from './store'

import { mainnet, gnosis } from './chains'
import { ChainConfig } from './chains/types'

import { blockDataToRows } from './fns/logToRows'

const V1_ADDRESS = getAddress('0x469788fe6e9e9681c6ebf3bf78e7fd26fc015446')
const V2_ADDRESS = getAddress('0xde1e8a7e184babd9f0e3af18f40634e9ed6f0905')

// Subsquid's RPC defaults: the head is polled every 5 s, a request times out
// after 30 s, and these pauses follow connection failures in a row
const POLL_INTERVAL = 5_000
const REQUEST_TIMEOUT = 30_000
const RETRY_PAUSES = [10, 100, 500, 2000, 10000, 20000]

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
async function sync(chain: ChainConfig, index: number) {
  const { chainId } = chain
  const client = createPublicClient({
    transport: http(chain.rpc, { timeout: REQUEST_TIMEOUT, retryCount: 0 }),
  })

  console.log(`Starting processor for ${chain.shortName}`)

  const checkpoint = await prisma.checkpoint.findUnique({ where: { chainId } })
  // like Subsquid, never resume from a block that is no longer on chain
  if (checkpoint && checkpoint.hash != '0x') {
    const block = await retry(() =>
      client.getBlock({ blockNumber: BigInt(checkpoint.blockNumber) })
    ).catch((e) => {
      if (e instanceof BlockNotFoundError) return undefined
      throw e
    })
    if (block?.hash != checkpoint.hash) {
      throw new Error(
        `already indexed block ${checkpoint.blockNumber}#${checkpoint.hash.slice(2, 7)} was not found on chain`
      )
    }
  }

  const finalizedHead = async () =>
    Number(await retry(() => client.getBlockNumber())) - chain.finality

  let from = checkpoint
    ? checkpoint.blockNumber + 1
    : chain.deploymentBlocks.DelegateRegistryV1
  let head = await finalizedHead()

  const metrics = {
    chainHeight: head,
    lastBlock: checkpoint?.blockNumber ?? -1,
  }
  serveMetrics(3000 + index, metrics)

  while (true) {
    if (from > head) {
      head = await finalizedHead()
      metrics.chainHeight = head
    }
    if (from > head) {
      await sleep(POLL_INTERVAL)
      continue
    }

    const to = Math.min(from + chain.blockRange - 1, head)
    const [logs, { hash }] = await retry(() =>
      Promise.all([
        client.getLogs({
          address: [V1_ADDRESS, V2_ADDRESS],
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        }),
        client.getBlock({ blockNumber: BigInt(to) }),
      ])
    )

    // the logs by block, timestamped with the blockTimestamp the RPC adds to
    // each log, or from the block header when it is missing or 0x0 (which
    // rpc.snapshot.org sometimes returns)
    const blocks = await Promise.all(
      [...new Set(logs.map((log) => log.blockNumber))].map(
        async (blockNumber) => {
          const blockLogs = logs.filter((log) => log.blockNumber == blockNumber)
          const { blockTimestamp } = blockLogs[0] as {
            blockTimestamp?: string
          }
          const timestamp =
            Number(blockTimestamp) ||
            Number(
              (await retry(() => client.getBlock({ blockNumber }))).timestamp
            )
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
    metrics.lastBlock = to
    if (rows.length > 0) {
      console.log(`[${chain.shortName}] ${rows.length} logs @ ${to}`)
    }

    from = to + 1
  }
}

/*
 * Retries what Subsquid's RPC client retried: connection failures, timeouts,
 * HTTP 429, 502, 503 and 504, and rate limit errors. Any other error stops the
 * indexer, as it stopped the Subsquid processor
 */
async function retry<T>(request: () => Promise<T>): Promise<T> {
  for (let failures = 1; ; failures++) {
    try {
      return await request()
    } catch (e) {
      // Subsquid asked again at once, up to 10 times, for a missing block
      if (e instanceof BlockNotFoundError && failures < 10) continue
      if (!isConnectionError(e)) throw e
      const pause = RETRY_PAUSES[Math.min(failures, RETRY_PAUSES.length) - 1]
      console.warn(`RPC connection failure, retrying in ${pause}ms`, String(e))
      await sleep(pause)
    }
  }
}

function isConnectionError(e: unknown): boolean {
  if (e instanceof TimeoutError) return true
  if (e instanceof HttpRequestError) {
    return e.status
      ? [429, 502, 503, 504].includes(e.status)
      : ['fetch failed', 'terminated'].includes((e.cause as Error)?.message)
  }
  return (
    e instanceof BaseError &&
    /rate limit|execution timeout|request.*timed out/i.test(e.details)
  )
}

/*
 * The progress gauges Subsquid served on /metrics, on the same port: 3000 for
 * Ethereum, 3001 for Gnosis
 */
function serveMetrics(
  port: number,
  metrics: { chainHeight: number; lastBlock: number }
) {
  createServer((req, res) => {
    if (req.method != 'GET' || req.url?.split('?')[0] != '/metrics') {
      res.writeHead(404).end()
      return
    }
    const chainHeight = Math.max(metrics.chainHeight, metrics.lastBlock)
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
    res.end(
      `# TYPE sqd_processor_chain_height gauge\nsqd_processor_chain_height ${chainHeight}\n` +
        `# TYPE sqd_processor_last_block gauge\nsqd_processor_last_block ${metrics.lastBlock}\n`
    )
  }).listen(port)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// an error stops both chains with exit code 1, as with Subsquid's processor
run().catch((e) => {
  console.error(e)
  process.exit(1)
})
