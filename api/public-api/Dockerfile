# ============================================================
# Stage 1 — Builder
# Installs ALL dependencies, compiles TypeScript, then prunes
# devDependencies for the production image.
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace root manifests (Yarn workspaces need root package.json).
# .yarnrc.yml is required so Yarn Berry respects nodeLinker: node-modules.
# .yarn/ is git-ignored and not needed (no PnP cache or offline mirror).
COPY package.json yarn.lock .yarnrc.yml ./

# Copy only this package's manifest — avoids rebuilding on unrelated changes
COPY api/public-api/package.json ./api/public-api/

# Activate Yarn Berry v4 via Corepack.
# node:22-alpine ships Yarn 1.x; the packageManager field in package.json
# specifies yarn@4.12.0 which requires Corepack to be explicitly enabled.
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Install all deps (including devDependencies for tsc)
RUN yarn workspaces focus @repo/public-api --production=false

# Copy source files and compile
COPY api/public-api/tsconfig.json ./api/public-api/
COPY api/public-api/src           ./api/public-api/src/

WORKDIR /app/api/public-api
RUN yarn build

# ============================================================
# Stage 2 — Production
# Copies only the compiled output and production node_modules.
# ============================================================
FROM node:22-alpine AS production

# Run as non-root user (uid 1001) matching Kubernetes podSecurityContext
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

# Copy compiled output and production dependencies
COPY --from=builder --chown=appuser:appgroup /app/api/public-api/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules        ./node_modules

USER appuser

EXPOSE 3001

# Healthcheck mirrors the Kubernetes startupProbe
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/healthz || exit 1

CMD ["node", "dist/index.js"]
