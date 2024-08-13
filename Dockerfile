# Base image
FROM node:18-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat
RUN addgroup --system nodejs && adduser --system --ingroup nodejs nodejs

# Dependencies installation stage
FROM base AS deps
COPY package.json ./
RUN npm install && npm cache clean --force

# Build stage for compiling TypeScript
FROM deps AS builder
COPY . .
RUN npm run build || exit 1

# Production stage, setting up the runtime environment
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

USER nodejs
EXPOSE 8081
CMD ["node", "dist/index.js"]
