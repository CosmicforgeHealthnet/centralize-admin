FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY services/central-admin-api/package*.json ./
RUN npm ci --omit=dev
COPY services/central-admin-api/prisma ./prisma
COPY services/central-admin-api/prisma*.ts ./
RUN npx prisma generate
COPY services/central-admin-api/ ./
EXPOSE 4000
CMD ["node", "src/server.js"]
