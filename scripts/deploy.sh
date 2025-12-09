#!/bin/bash
set -e

# Calq MCP Production Deployment Script
# Usage: ./scripts/deploy.sh [--build]

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🚀 Calq MCP Production Deployment${NC}"
echo "=================================="

# Check if .env.production exists
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Error: $ENV_FILE not found${NC}"
    echo "Copy .env.production.example to .env.production and configure it"
    exit 1
fi

# Load environment variables
export $(grep -v '^#' $ENV_FILE | xargs)

# Validate required variables
required_vars=(
    "DOMAIN"
    "POSTGRES_PASSWORD"
    "VOYAGE_API_KEY"
    "GITHUB_CLIENT_ID"
    "GITHUB_CLIENT_SECRET"
    "ACME_EMAIL"
)

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}Error: $var is not set in $ENV_FILE${NC}"
        exit 1
    fi
done

echo -e "${GREEN}✓ Environment validated${NC}"

# Build if requested
if [ "$1" == "--build" ]; then
    echo -e "${YELLOW}Building images...${NC}"
    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE build --no-cache
fi

# Pull latest images
echo -e "${YELLOW}Pulling latest images...${NC}"
docker compose -f $COMPOSE_FILE --env-file $ENV_FILE pull

# Stop existing containers
echo -e "${YELLOW}Stopping existing containers...${NC}"
docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down

# Start containers
echo -e "${YELLOW}Starting containers...${NC}"
docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d

# Wait for health checks
echo -e "${YELLOW}Waiting for services to be healthy...${NC}"
sleep 10

# Check status
echo ""
echo -e "${GREEN}Container Status:${NC}"
docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps

# Run database migrations
echo ""
echo -e "${YELLOW}Running database migrations...${NC}"
docker compose -f $COMPOSE_FILE --env-file $ENV_FILE exec calq npm run db:push

echo ""
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "Services:"
echo "  - Calq MCP: https://${DOMAIN}/mcp"
echo "  - OAuth:    https://${DOMAIN}/oauth/authorize"
echo "  - Health:   https://${DOMAIN}/health"
