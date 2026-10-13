# syntax = docker/dockerfile:1

FROM node:21-slim

LABEL fly_launch_runtime="Node.js"

# Install Bun
RUN npm install -g bun

# Install necessary packages for Prisma
RUN apt-get update -qq && \
    apt-get install -y build-essential pkg-config python-is-python3 openssl

WORKDIR /app

# Copy package files
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src

# Install dependencies
RUN bun install --frozen-lockfile

# Build the application
ENV NODE_ENV="production"
RUN bun run build

# Expose the Prometheus metrics ports
# (PROMETHEUS_PORT env var is read by @subsquid/util-internal-prometheus-server)
# ENV PROMETHEUS_PORT=3000  
EXPOSE 3000-3099

CMD ["bun", "run", "start"]

