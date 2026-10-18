FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY services/central-admin-api/package*.json ./
RUN npm ci --omit=dev
COPY services/central-admin-api/prisma ./prisma
COPY services/central-admin-api/prisma*.ts ./
# Prisma client generation is an offline build step. A non-secret, non-routable
# placeholder satisfies config parsing; actual DATABASE_URL is runtime-only.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npx prisma generate
COPY services/central-admin-api/ ./
EXPOSE 4000
CMD ["node", "src/server.js"]
