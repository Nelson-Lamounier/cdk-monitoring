# =============================================================================
# mcp-infra-diagram — Multi-stage Alpine build
# Discovers live AWS + K8s infrastructure and generates architecture diagrams
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
COPY mcp-servers/mcp-infra-diagram/package.json mcp-servers/mcp-infra-diagram/package.json

# Install all dependencies (dev + prod — needed for tsc build)
RUN yarn workspaces focus @portfolio/mcp-infra-diagram

# ---------------------------------------------------------------------------
# Stage 2: Build TypeScript
# ---------------------------------------------------------------------------
FROM deps AS build

# Copy source code
COPY mcp-servers/mcp-infra-diagram/src mcp-servers/mcp-infra-diagram/src
COPY mcp-servers/mcp-infra-diagram/tsconfig.json mcp-servers/mcp-infra-diagram/tsconfig.json

# Compile TypeScript → dist/
RUN cd mcp-servers/mcp-infra-diagram && yarn build

# ---------------------------------------------------------------------------
# Stage 3: Production runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

WORKDIR /app

# Copy workspace manifests for production install
COPY package.json yarn.lock .yarnrc.yml ./
COPY mcp-servers/mcp-infra-diagram/package.json mcp-servers/mcp-infra-diagram/package.json

# Install production dependencies only
RUN yarn workspaces focus @portfolio/mcp-infra-diagram --production \
    && yarn cache clean

# Copy compiled output from build stage
COPY --from=build /app/mcp-servers/mcp-infra-diagram/dist mcp-servers/mcp-infra-diagram/dist

WORKDIR /app/mcp-servers/mcp-infra-diagram

# MCP uses stdio — no ports to expose
ENTRYPOINT ["node", "dist/index.js"]
