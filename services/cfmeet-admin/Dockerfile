# CF Meet Admin — independent, non-root, private-only service image.
# Build from the REPOSITORY ROOT so the shared protocol packages are included
# with the same relative layout used in the repository:
#
#   docker build -f services/cfmeet-admin/Dockerfile -t cfmeet-admin:local .
#
# BuildKit applies services/cfmeet-admin/Dockerfile.dockerignore (the root
# .dockerignore excludes packages/ for the existing API image).
FROM node:22-alpine

ENV NODE_ENV=production \
    CFMEET_ADMIN_ENABLED=false \
    CFMEET_ADMIN_LISTEN=unix:/run/cosmicforge/cfmeet-admin.sock

RUN addgroup -S -g 10003 cosmicforge && adduser -S -D -H -u 10003 -G cosmicforge cosmicforge \
 && mkdir -p /run/cosmicforge && chown 10003:10003 /run/cosmicforge

WORKDIR /app
COPY packages/admin-contracts/package.json packages/admin-contracts/
COPY packages/admin-contracts/src packages/admin-contracts/src
COPY packages/admin-contracts/schemas packages/admin-contracts/schemas
COPY packages/service-clients/package.json packages/service-clients/
COPY packages/service-clients/src packages/service-clients/src
COPY packages/identity-and-permissions/package.json packages/identity-and-permissions/
COPY packages/identity-and-permissions/src packages/identity-and-permissions/src
COPY packages/event-contracts/package.json packages/event-contracts/
COPY packages/event-contracts/src packages/event-contracts/src

WORKDIR /app/services/cfmeet-admin
COPY services/cfmeet-admin/package.json services/cfmeet-admin/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY services/cfmeet-admin/src ./src
COPY services/cfmeet-admin/scripts ./scripts
COPY services/cfmeet-admin/migrations ./migrations

USER 10003:10003
# No EXPOSE: the default listener is a host-private Unix socket in
# /run/cosmicforge (mount a host directory shared only with the approved
# Product Integration Core group). Never publish a TCP port publicly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({socketPath:(process.env.CFMEET_ADMIN_LISTEN||'').replace(/^unix:/,''),path:'/health/live'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server/index.js"]
