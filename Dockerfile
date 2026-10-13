# The API and the indexer on one server, see start.js and DEPLOY.md
FROM node:22-slim

# Prisma's engines need OpenSSL, and curl reads /metrics from the console
RUN apt-get update -qq && apt-get install -y -qq openssl curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.4.0

WORKDIR /app

COPY packages/api packages/api
COPY packages/indexer packages/indexer
COPY package.json start.js ./

RUN bun run build

CMD ["bun", "run", "start"]
