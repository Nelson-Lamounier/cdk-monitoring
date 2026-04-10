# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace manifests first to leverage Docker layer caching.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn/
COPY api/admin-api/package.json  api/admin-api/
COPY api/admin-api/tsconfig.json api/admin-api/

# Install only admin-api dependencies (no workspace hoisting needed at runtime).
RUN yarn workspaces focus @repo/admin-api --production=false

# Copy source and build.
COPY api/admin-api/src api/admin-api/src/
RUN yarn workspace @repo/admin-api build

# Prune devDependencies.
RUN yarn workspaces focus @repo/admin-api --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Security: run as dedicated non-root user.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs adminapi

WORKDIR /app

# Copy built artefacts and production dependencies.
COPY --from=builder --chown=adminapi:nodejs /app/api/admin-api/dist      ./dist/
COPY --from=builder --chown=adminapi:nodejs /app/node_modules            ./node_modules/
COPY --from=builder --chown=adminapi:nodejs /app/api/admin-api/package.json ./

USER adminapi

# Port 3002 — admin-api (public-api uses 3001).
EXPOSE 3002

# Kubernetes liveness probe target.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3002/healthz || exit 1

CMD ["node", "dist/index.js"]
