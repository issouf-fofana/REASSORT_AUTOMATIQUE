# Build stage
FROM node:18-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/
COPY src ./src/
COPY public-fallback ./public-fallback/
COPY scripts ./scripts/
COPY magasins.json ./

# Install dependencies
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# =============================================
# Production stage
# =============================================
FROM node:18-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

# Set to production
ENV NODE_ENV=production

# Copy built application
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/public-fallback ./public-fallback
COPY --from=builder /app/magasins.json ./
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Start application
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
