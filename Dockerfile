FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

# Data directory will be mounted as a volume
ENV HOME=/data

ENTRYPOINT ["node", "src/index.js"]
