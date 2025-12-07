FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --only=production

COPY src ./src

# Data directory will be mounted as a volume
ENV HOME=/data
ENV MCP_PORT=3000

EXPOSE 3000

ENTRYPOINT ["node", "src/index.js"]
