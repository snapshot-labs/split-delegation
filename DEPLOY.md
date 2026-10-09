# Deploy on DigitalOcean App Platform

One app with three components, all built from this repository by App Platform's Node.js buildpack. The spec is [.do/app.yaml](.do/app.yaml).

| Component | Type | Source directory | Build | Run | Size |
| --- | --- | --- | --- | --- | --- |
| api | Web service, port 8080 | `packages/api` | `yarn build` | `yarn start` | `apps-s-1vcpu-1gb-fixed`, $10/month |
| indexer | Worker | `packages/indexer` | `pnpm build` | `pnpm start` | `apps-s-1vcpu-0.5gb`, $5/month |
| nightly | Job, daily at 00:00 UTC | `packages/api` | | calls `GET /api/v1/nightly` | `apps-s-1vcpu-0.5gb`, billed only while it runs |

- `pnpm start` applies the Prisma migrations (`prisma migrate deploy`), then syncs. Nothing else runs migrations.
- The API is checked on its TCP port. Its only GET route, `/api/v1/nightly`, prunes the cache, so it is not a health check.
- In tests the API peaked at about 530 MB and the indexer at about 140 MB. Move a component one size up if it restarts out of memory.

## Database

The app-level secret `POSTGRES_PRISMA_URL` holds the Postgres connection string, for the API and the indexer. With PlanetScale Postgres:

1. New database, Postgres, region AWS us-east-1 (near App Platform's `nyc`), cluster PS-5.
2. Connect, Default role, Create default role. The password is shown only once.
3. `postgresql://USERNAME:PASSWORD@HOST:5432/postgres?sslmode=require`

Use port 5432: Prisma migrations need a direct connection, not PgBouncer (6432). Use `sslmode=require`: Prisma 6.5 reads `verify-full`, which PlanetScale suggests, as `prefer`, and `prefer` also allows unencrypted connections.

## Create the app

1. In App Platform, create an app from GitHub: `snapshot-labs/split-delegation`, branch `main`, source directory `/packages/api`, region New York. From the repository root, App Platform finds no package and offers a Function.
2. Once it is created, open Settings, App Spec, Edit. Paste `.do/app.yaml` with the real `POSTGRES_PRISMA_URL` and save. App Platform encrypts the secret and redeploys.

With doctl: `doctl apps create --spec .do/app.yaml`, after setting the value.

## First sync

From an empty database, the indexer reads every registry log from block 11,225,329 on Ethereum and 20,274,491 on Gnosis. On rpc.snapshot.org this takes about 2.5 hours, and until then the API's answers miss recent delegations.

To skip it, restore a synced database before the indexer first starts. The dump includes `_prisma_migrations`, so `prisma migrate deploy` has nothing to apply, and the indexer resumes from the dump's checkpoint:

```sh
pg_dump -Fc --no-owner --no-privileges -t '"DelegationEvent"' -t '"Checkpoint"' -t '"Cache"' \
  -t '"_prisma_migrations"' --exclude-table-data='"Cache"' -d "$SOURCE_URL" -f seed.dump
pg_restore --no-owner --no-privileges -d "$POSTGRES_PRISMA_URL" seed.dump
```

## Check

- Indexer: in the Console tab of the indexer, `curl -s localhost:3000/metrics` for Ethereum and `curl -s localhost:3001/metrics` for Gnosis. It has caught up when `sqd_processor_last_block` equals `sqd_processor_chain_height`.
- API: `POST /api/v1/<space>/<block>/voting-power` with a split-delegation strategy and addresses, as in the [README](README.md).
- Nightly job: its runs are listed under Activity, Jobs, and each logs `nightly 200`.

## Point spaces at it

In each space, set `backendUrl` in the split-delegation strategy to the app URL, and use the same URL for the delegation API in the space's Delegation settings.
