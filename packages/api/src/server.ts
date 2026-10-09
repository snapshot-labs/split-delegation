import express, { RequestHandler } from 'express'

import { POST as address } from '../api/v1/[space]/[tag]/[address]'
import { POST as topDelegates } from '../api/v1/[space]/[tag]/top-delegates'
import { POST as votingPower } from '../api/v1/[space]/[tag]/voting-power'
import { GET as nightly } from '../api/v1/nightly'

type Handler = (
  req: Request,
  context: { waitUntil: (promise: Promise<unknown>) => void }
) => Promise<Response>

const app = express()

// the headers vercel.json added to every /api response
app.use('/api', (_req, res, next) => {
  res.set({
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
    'Access-Control-Allow-Headers':
      'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version',
  })
  next()
})

// the handlers parse the body themselves, whatever its content type, and
// voting-power gets every voter: keep Vercel's 4.5mb limit, not Express's 100kb
const rawBody = express.raw({ type: () => true, limit: '4.5mb' })

app.post('/api/v1/:space/:tag/top-delegates', rawBody, handle(topDelegates))
app.post('/api/v1/:space/:tag/voting-power', rawBody, handle(votingPower))
app.post('/api/v1/:space/:tag/:address', rawBody, handle(address))
app.get('/api/v1/nightly', handle(nightly))

app.listen(Number(process.env.PORT) || 3000)

/*
 * Calls a handler the way Vercel did: path parameters in the query string,
 * and the work passed to waitUntil carries on after the response
 */
function handle(handler: Handler): RequestHandler {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    for (const [key, value] of Object.entries(req.params)) {
      url.searchParams.set(key, String(value))
    }

    const response = await handler(
      new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.body,
      }),
      { waitUntil: (promise) => promise.catch(console.error) }
    )

    res.status(response.status)
    response.headers.forEach((value, key) => res.setHeader(key, value))
    res.end(Buffer.from(await response.arrayBuffer()))
  }
}
