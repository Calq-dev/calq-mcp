FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++

COPY src ./src

# Data directory will be mounted as a volume
ENV HOME=/data
ENV NODE_ENV=production

ENTRYPOINT ["node", "src/index.js"]
