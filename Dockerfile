FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache python3 make g++ curl && \
    npm ci --omit=dev && \
    apk del python3 make g++

COPY src ./src

# Data directory will be mounted as a volume
ENV HOME=/data
ENV MCP_PORT=3000
ENV NODE_ENV=production

ARG PORT=3000
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${MCP_PORT}/health || exit 1

ENTRYPOINT ["node", "src/index.js"]
