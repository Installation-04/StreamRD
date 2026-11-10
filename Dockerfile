# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
FROM base AS streamrd-server
COPY server/package.json server/package-lock.json ./
COPY server/prisma ./prisma
RUN --mount=type=secret,id=proxy_ca set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --strict-ssl=true --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/scripts/clean-build.cjs ./scripts/clean-build.cjs
COPY server/src ./src
RUN --mount=type=secret,id=proxy_ca set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; ./node_modules/.bin/prisma generate && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
FROM base AS phosphor-server
COPY phosphor/server/package.json phosphor/server/package-lock.json ./
COPY phosphor/server/prisma ./prisma
RUN --mount=type=secret,id=proxy_ca set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --strict-ssl=true --no-audit --no-fund
COPY phosphor/server/tsconfig.json phosphor/server/tsconfig.build.json ./
COPY phosphor/server/scripts/clean-build.cjs ./scripts/clean-build.cjs
COPY phosphor/server/src ./src
RUN --mount=type=secret,id=proxy_ca set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; ./node_modules/.bin/prisma generate && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
FROM base AS streamrd-web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --strict-ssl=true --no-audit --no-fund
COPY web ./
ENV NEXT_PUBLIC_API_BASE_URL="" NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM base AS phosphor-web
COPY phosphor/web/package.json phosphor/web/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca set -eu; if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --strict-ssl=true --no-audit --no-fund
COPY phosphor/web ./
ENV NEXT_PUBLIC_API_BASE_URL="" NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM base AS bundle
WORKDIR /opt
RUN --mount=type=bind,from=streamrd-server,source=/app,target=/mnt/streamrd-server \
    --mount=type=bind,from=phosphor-server,source=/app,target=/mnt/phosphor-server \
    --mount=type=bind,from=streamrd-web,source=/app,target=/mnt/streamrd-web \
    --mount=type=bind,from=phosphor-web,source=/app,target=/mnt/phosphor-web \
    --mount=type=bind,source=server/scripts,target=/mnt/streamrd-scripts \
    --mount=type=bind,source=phosphor/server/scripts,target=/mnt/phosphor-scripts \
    set -eu; \
    for product in streamrd phosphor; do \
      mkdir -p /opt/$product/server/scripts /opt/$product/web/.next; \
      for entry in node_modules dist prisma package.json; do cp -a /mnt/$product-server/$entry /opt/$product/server/; done; \
      for entry in prepare-db.cjs backup-db.cjs migrate-db.cjs database-state.cjs db-status.cjs; do cp /mnt/$product-scripts/$entry /opt/$product/server/scripts/; done; \
      cp -a /mnt/$product-web/.next/standalone/. /opt/$product/web/; \
      cp -a /mnt/$product-web/.next/static /opt/$product/web/.next/; \
      cp -a /mnt/$product-web/public /opt/$product/web/; \
    done

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends qbittorrent-nox tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/data
WORKDIR /opt
RUN mkdir -p /config /data && chown node:node /config /data
COPY --from=bundle --chown=node:node /opt /opt
COPY --chown=node:node infra/single-container/start.cjs infra/single-container/health.cjs /opt/single-container/
USER node
VOLUME ["/config", "/data"]
EXPOSE 8080 8081 6881/tcp 6881/udp
HEALTHCHECK --interval=30s --timeout=8s --start-period=90s --retries=3 CMD ["node", "/opt/single-container/health.cjs"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/single-container/start.cjs"]
