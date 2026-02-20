FROM node:24-slim AS builder
WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifest files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy rest of the project
COPY . .

# Build TypeScript
RUN pnpm run build

# --- Runtime Stage ---
FROM node:24-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*
RUN useradd -m nodejs

# Copy compiled output and production dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
EXPOSE 3000

USER nodejs

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
