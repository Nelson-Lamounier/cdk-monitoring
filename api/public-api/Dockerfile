# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Installs ALL dependencies, compiles TypeScript, then prunes
# devDependencies for the runtime image.
FROM node:22-alpine AS builder

WORKDIR /app

# Activate Yarn Berry v4 via Corepack BEFORE copying any files.
# node:22-alpine ships Yarn 1.x; the root package.json declares
# "packageManager": "yarn@4.12.0" which requires Corepack.
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Copy workspace root manifests.
# .yarnrc.yml must be included so Yarn Berry respects nodeLinker: node-modules.
# .yarn/ is git-ignored and not needed (no PnP cache or offline mirror).
COPY package.json yarn.lock .yarnrc.yml ./

# Copy only this package's manifest — avoids rebuilding on unrelated changes.
COPY api/public-api/package.json ./api/public-api/

# Install all deps including devDependencies (needed for tsc).
# Yarn Berry v4: omit --production to get devDeps.
RUN yarn workspaces focus @repo/public-api

# Copy source files and compile.
COPY api/public-api/tsconfig.json ./api/public-api/
COPY api/public-api/src            ./api/public-api/src/

RUN yarn workspace @repo/public-api build

# Prune to production-only deps for the runtime layer.
RUN yarn workspaces focus @repo/public-api --production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Run as non-root user (uid 1001) matching Kubernetes podSecurityContext.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /app

# Copy compiled output and production dependencies.
# node_modules is copied from the workspace root (hoisted by Yarn workspaces).
COPY --from=builder --chown=appuser:appgroup /app/api/public-api/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules        ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/api/public-api/package.json ./

USER appuser

EXPOSE 3001

# Healthcheck mirrors the Kubernetes startupProbe.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/healthz || exit 1

CMD ["node", "dist/index.js"]
