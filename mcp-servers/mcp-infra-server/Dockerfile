# =============================================================================
# mcp-infra-server — Multi-stage Alpine build
# Produces a minimal image with Helm CLI for K8s + AWS diagnostics
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

WORKDIR /app

# Copy workspace root manifests
COPY package.json yarn.lock .yarnrc.yml ./

# Copy only the workspace package.json we need
COPY mcp-servers/mcp-infra-server/package.json mcp-servers/mcp-infra-server/package.json

# Install all dependencies (dev + prod — needed for tsc build)
RUN yarn workspaces focus @portfolio/mcp-infra-server

# ---------------------------------------------------------------------------
# Stage 2: Build TypeScript
# ---------------------------------------------------------------------------
FROM deps AS build

# Copy source code
COPY mcp-servers/mcp-infra-server/src mcp-servers/mcp-infra-server/src
COPY mcp-servers/mcp-infra-server/tsconfig.json mcp-servers/mcp-infra-server/tsconfig.json

# Compile TypeScript → dist/
RUN cd mcp-servers/mcp-infra-server && yarn build

# ---------------------------------------------------------------------------
# Stage 3: Production runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Install Helm CLI (manage_helm tool) + openssl (required for checksum verification on Alpine)
RUN apk add --no-cache openssl curl bash \
    && curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

WORKDIR /app

# Copy workspace manifests for production install
COPY package.json yarn.lock .yarnrc.yml ./
COPY mcp-servers/mcp-infra-server/package.json mcp-servers/mcp-infra-server/package.json

# Install production dependencies only
RUN yarn workspaces focus @portfolio/mcp-infra-server --production \
    && yarn cache clean

# Copy compiled output from build stage
COPY --from=build /app/mcp-servers/mcp-infra-server/dist mcp-servers/mcp-infra-server/dist

WORKDIR /app/mcp-servers/mcp-infra-server

# MCP uses stdio — no ports to expose
ENTRYPOINT ["node", "dist/index.js"]
