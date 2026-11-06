# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=secret,id=proxy_ca \
    set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/clean-build.cjs ./scripts/clean-build.cjs
COPY src ./src
RUN --mount=type=secret,id=proxy_ca \
    set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    ./node_modules/.bin/prisma generate && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production PORT=61337 DATABASE_URL=file:/app/data/phosphor.db
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/prepare-db.cjs scripts/backup-db.cjs ./scripts/
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 61337
# Pinned schema tooling is retained; compiler/test/tsx packages are pruned.
CMD ["sh", "-c", "node scripts/prepare-db.cjs && exec node dist/src/index.js"]
