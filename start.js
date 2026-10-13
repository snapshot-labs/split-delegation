/*
 * Runs the API and the indexer on one server, each in its own process with its
 * own `bun run start`, as App Platform ran the api service and indexer worker:
 * - the indexer is restarted whenever it exits, with Kubernetes' crash backoff
 *   (10 s, doubling up to 5 min, reset after 10 min up), and the API keeps
 *   serving meanwhile
 * - when the API exits, the indexer is stopped and this process exits with the
 *   API's code, so the platform restarts both
 * - SIGTERM and SIGINT are passed to both, which stop as they did on their own
 * - the API listens on PORT, 8080 by default as on App Platform, since its own
 *   default, 3000, is the indexer's Ethereum /metrics port
 */
const { spawn } = require('node:child_process')
const { constants } = require('node:os')
const path = require('node:path')

const BACKOFF_MIN = 10_000
const BACKOFF_MAX = 300_000
const BACKOFF_RESET = 600_000

let stopping = false
let indexer
let restartTimer

const start = (pkg, env) =>
  spawn('bun', ['run', 'start'], {
    cwd: path.join(__dirname, 'packages', pkg),
    env: { ...process.env, ...env },
    stdio: 'inherit',
    // its own process group, so signals reach the processes `bun run` starts
    detached: true,
  })

const running = (child) => child.exitCode === null && child.signalCode === null

// signals the child's whole process group, which may outlive the child
function kill(child, sig) {
  try {
    process.kill(-child.pid, sig)
  } catch {}
}

const api = start('api', { PORT: process.env.PORT || '8080' })
api.on('exit', (code, signal) => {
  stopping = true
  clearTimeout(restartTimer)
  if (indexer && running(indexer)) {
    indexer.on('exit', () => exit(code, signal))
    kill(indexer, 'SIGTERM')
  } else {
    exit(code, signal)
  }
})

let backoff = BACKOFF_MIN
function startIndexer() {
  const startedAt = Date.now()
  indexer = start('indexer')
  indexer.on('exit', (code, signal) => {
    if (stopping) return
    kill(indexer, 'SIGKILL')
    if (Date.now() - startedAt >= BACKOFF_RESET) backoff = BACKOFF_MIN
    console.error(
      `indexer exited with ${signal || `code ${code}`}, restarting in ${backoff / 1000}s`
    )
    restartTimer = setTimeout(startIndexer, backoff)
    backoff = Math.min(backoff * 2, BACKOFF_MAX)
  })
}
startIndexer()

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true
    clearTimeout(restartTimer)
    kill(api, sig)
    kill(indexer, sig)
  })
}

function exit(code, signal) {
  process.exit(code ?? 128 + constants.signals[signal])
}
