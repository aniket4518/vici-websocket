FROM node:24-slim AS builder
WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifest files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy Prisma schema and generate client before full copy
COPY prisma ./prisma
RUN npx prisma generate

# Copy rest of the project
COPY . .

# Build TypeScript
RUN pnpm run build

# --- Runtime Stage ---
FROM node:24-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*
RUN useradd -m nodejs

# Enable pnpm in runner too
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifest files and install production-only deps (smaller image)
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy Prisma schema and regenerate client for production
COPY --from=builder /app/prisma ./prisma
RUN npx prisma generate

# Copy compiled output
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

USER nodejs

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
