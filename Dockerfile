# Base image
FROM node:18-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat
RUN addgroup --system nodejs && adduser --system --ingroup nodejs nodejs

# Dependencies installation stage
FROM base AS deps
COPY package*.json ./
COPY yarn.lock* pnpm-lock.yaml* ./
RUN if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm and pnpm install --frozen-lockfile; \
    else echo "Lockfile not found." && exit 1; \
    fi

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

ENV TWILIO_ACCOUNT_ID="ACf4ac03ab3333cd6d53962035dfb0b743" 
ENV TWILIO_AUTH_TOKEN="0ad3adc856860524079f10777b09a7ef"
ENV RETELL_API_KEY="25ef6a3c-3a77-4a03-9c5e-a19a64e2491b"
ENV OPENAI_APIKEY="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"

USER nodejs
EXPOSE 8081
CMD ["node", "dist/index.js"]
