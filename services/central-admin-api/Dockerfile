FROM node:20-alpine

# Required by Prisma on alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy the rest of the source code
COPY . .

EXPOSE 4000

CMD ["node", "src/server.js"]