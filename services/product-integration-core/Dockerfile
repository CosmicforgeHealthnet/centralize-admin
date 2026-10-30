# Product Integration Core — HQ-side, non-root, private-only service image.
# Build from the REPOSITORY ROOT so the shared protocol packages are included
# with the same relative layout used in the repository:
#
#   docker build -f services/product-integration-core/Dockerfile -t product-integration-core:local .
#
# BuildKit applies services/product-integration-core/Dockerfile.dockerignore
# (the root .dockerignore excludes packages/ for the existing API image).
FROM node:22-alpine

ENV NODE_ENV=production \
    PIC_ENABLED=false \
    PIC_LISTEN=unix:/run/cosmicforge/product-integration-core.sock

RUN addgroup -S -g 10002 cosmicforge-pic && adduser -S -D -H -u 10002 -G cosmicforge-pic cosmicforge-pic \
 && mkdir -p /run/cosmicforge && chown 10002:10002 /run/cosmicforge

WORKDIR /app
COPY packages/admin-contracts/package.json packages/admin-contracts/
COPY packages/admin-contracts/src packages/admin-contracts/src
COPY packages/service-clients/package.json packages/service-clients/
COPY packages/service-clients/src packages/service-clients/src
COPY packages/identity-and-permissions/package.json packages/identity-and-permissions/
COPY packages/identity-and-permissions/src packages/identity-and-permissions/src
COPY packages/event-contracts/package.json packages/event-contracts/
COPY packages/event-contracts/src packages/event-contracts/src

WORKDIR /app/services/product-integration-core
COPY services/product-integration-core/package.json services/product-integration-core/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY services/product-integration-core/src ./src
COPY services/product-integration-core/scripts ./scripts
COPY services/product-integration-core/migrations ./migrations

USER 10002:10002
# No EXPOSE: the default listener is a host-private Unix socket shared only
# with the Central Admin API. Never publish this service to the internet.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({socketPath:(process.env.PIC_LISTEN||'').replace(/^unix:/,''),path:'/health/live'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server/index.js"]
