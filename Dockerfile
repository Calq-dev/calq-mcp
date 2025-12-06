FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

# Data directory will be mounted as a volume
ENV HOME=/data
ENV MCP_MODE=http
ENV MCP_PORT=3000

EXPOSE 3000 3847

ENTRYPOINT ["node", "src/index.js"]
