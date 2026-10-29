FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 10001 cosmicforge && adduser -S -D -u 10001 -G cosmicforge cosmicforge
COPY package.json ./
COPY src ./src
USER 10001:10001
# No EXPOSE: communication is a host-private Unix socket mounted into
# /run/cosmicforge and accessible only to the approved Central Admin group.
CMD ["node", "src/server.js"]
