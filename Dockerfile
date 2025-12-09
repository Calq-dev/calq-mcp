FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY drizzle.config.js ./

# Data directory will be mounted as a volume
ENV HOME=/data
ENV NODE_ENV=production

ENTRYPOINT ["node", "src/index.js"]
