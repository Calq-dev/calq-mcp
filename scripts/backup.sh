#!/bin/bash
set -e

# Calq MCP Database Backup Script
# Usage: ./scripts/backup.sh

BACKUP_DIR="/var/backups/calq"
DATE=$(date +%Y%m%d_%H%M%S)
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}📦 Calq MCP Backup${NC}"
echo "==================="

# Create backup directory
mkdir -p $BACKUP_DIR

# Load environment
export $(grep -v '^#' $ENV_FILE | xargs)

# Backup PostgreSQL
echo -e "${YELLOW}Backing up PostgreSQL...${NC}"
docker compose -f $COMPOSE_FILE exec -T postgres pg_dump -U calq calq | gzip > "$BACKUP_DIR/postgres_$DATE.sql.gz"

# Backup ChromaDB data
echo -e "${YELLOW}Backing up ChromaDB...${NC}"
docker compose -f $COMPOSE_FILE exec -T chromadb tar czf - /chroma/chroma > "$BACKUP_DIR/chromadb_$DATE.tar.gz"

# Remove backups older than 30 days
echo -e "${YELLOW}Cleaning old backups...${NC}"
find $BACKUP_DIR -type f -mtime +30 -delete

echo -e "${GREEN}✅ Backup complete!${NC}"
echo "Files:"
ls -lh $BACKUP_DIR/*_$DATE.*
