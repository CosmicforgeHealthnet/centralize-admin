FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'require("http").get("http://127.0.0.1:4100/health/live",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))'
CMD ["node","src/server.js"]
