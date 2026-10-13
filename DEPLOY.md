# Deploy on DigitalOcean App Platform

One app with two components, built from this repository.

| Component | Type | Build | Run | Size |
| --- | --- | --- | --- | --- |
| api | Web service, port 8080 | [Dockerfile](Dockerfile) | the API and the indexer, see [start.js](start.js) | `apps-s-1vcpu-1gb-fixed`, $10/month |
| nightly | Job, daily at 00:00 UTC | App Platform's Bun buildpack, from `packages/api` | calls `GET /api/v1/nightly` | `apps-s-1vcpu-0.5gb`, billed only while it runs |

- The API and the indexer run side by side, each with its own `bun run start` in its package, as when they were separate components:
  - The indexer applies the Prisma migrations (`prisma migrate deploy`), then syncs. Nothing else runs migrations.
  - When the indexer exits, it is restarted after 10 s, doubling up to 5 min, and the API keeps serving.
  - When the API exits, the indexer is stopped and the component restarts.
- The API is checked on its TCP port. Its only GET route, `/api/v1/nightly`, prunes the cache, so it is not a health check.
- In tests the API peaked at about 530 MB and the indexer at about 140 MB. Move the component one size up if it restarts out of memory.

## Database

The app-level secret `POSTGRES_PRISMA_URL` holds the Postgres connection string, for the API and the indexer. With PlanetScale Postgres:

1. New database, Postgres, region AWS us-east-1 (near App Platform's `nyc`), cluster PS-5.
2. Connect, Default role, Create default role. The password is shown only once.
3. `postgresql://USERNAME:PASSWORD@HOST:5432/postgres?sslmode=require`

Use port 5432: Prisma migrations need a direct connection, not PgBouncer (6432). Use `sslmode=require`: Prisma 6.5 reads `verify-full`, which PlanetScale suggests, as `prefer`, and `prefer` also allows unencrypted connections.

## Create the app

1. In App Platform, create an app from GitHub: `snapshot-labs/split-delegation`, branch `main`, autodeploy on, source directory `/`, region New York. App Platform builds it from the root `Dockerfile`.
2. Name the web service `api`, with HTTP port 8080 and size `apps-s-1vcpu-1gb-fixed`, 1 instance.
3. In the app's settings, add the environment variable `POSTGRES_PRISMA_URL`, encrypted, scope run time.
4. Add a job named `nightly`, from the same repository and branch, source directory `/packages/api`, scheduled `0 0 * * *` UTC, size `apps-s-1vcpu-0.5gb`, with:
   - Run command: `node -e "fetch(process.env.APP_URL + '/api/v1/nightly').then((r) => console.log('nightly', r.status))"`
   - Environment variable `APP_URL`, scope run time, value `${APP_URL}`

## First sync

From an empty database, the indexer reads every registry log from block 11,225,329 on Ethereum and 20,274,491 on Gnosis. On rpc.snapshot.org this takes about 2.5 hours, and until then the API's answers miss recent delegations.

To skip it, restore a synced database before the indexer first starts. The dump includes `_prisma_migrations`, so `prisma migrate deploy` has nothing to apply, and the indexer resumes from the dump's checkpoint:

```sh
pg_dump -Fc --no-owner --no-privileges -t '"DelegationEvent"' -t '"Checkpoint"' -t '"Cache"' \
  -t '"_prisma_migrations"' --exclude-table-data='"Cache"' -d "$SOURCE_URL" -f seed.dump
pg_restore --no-owner --no-privileges -d "$POSTGRES_PRISMA_URL" seed.dump
```

## Check

- Indexer: in the Console tab of the api, `curl -s localhost:3000/metrics` for Ethereum and `curl -s localhost:3001/metrics` for Gnosis. It has caught up when `sqd_processor_last_block` equals `sqd_processor_chain_height`.
- API: `POST /api/v1/<space>/<block>/voting-power` with a split-delegation strategy and addresses, as in the [README](README.md).
- Nightly job: its runs are listed under Activity, Jobs, and each logs `nightly 200`.

## Point spaces at it

In each space, set `backendUrl` in the split-delegation strategy to the app URL, and use the same URL for the delegation API in the space's Delegation settings.
