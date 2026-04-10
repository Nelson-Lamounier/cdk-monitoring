# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Activate Yarn Berry v4 via Corepack BEFORE copying any files.
# node:22-alpine ships Yarn 1.x; the root package.json declares
# "packageManager": "yarn@4.12.0" which requires Corepack.
# Must run before COPY so the cache layer is reused on manifest-only changes.
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Copy workspace manifests first to leverage Docker layer caching.
# .yarn/ is git-ignored (only install-state.gz exists locally);
# nodeLinker: node-modules only requires package.json + yarn.lock + .yarnrc.yml.
COPY package.json yarn.lock .yarnrc.yml ./
COPY api/admin-api/package.json  api/admin-api/
COPY api/admin-api/tsconfig.json api/admin-api/

# Install all deps including devDependencies (needed for tsc).
# Yarn Berry v4 flag: omit --production to get devDeps; --production for prod-only.
RUN yarn workspaces focus @repo/admin-api

# Copy source and compile.
COPY api/admin-api/src api/admin-api/src/
RUN yarn workspace @repo/admin-api build

# Prune to production-only deps for the runtime layer.
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
