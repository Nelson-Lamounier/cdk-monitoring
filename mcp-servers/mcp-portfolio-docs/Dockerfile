# =============================================================================
# mcp-portfolio-docs — Multi-stage Alpine build
# Evidence-based portfolio documentation generator
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
COPY mcp-servers/mcp-portfolio-docs/package.json mcp-servers/mcp-portfolio-docs/package.json

# Install all dependencies (dev + prod — needed for tsc build)
RUN yarn workspaces focus @portfolio/mcp-portfolio-docs

# ---------------------------------------------------------------------------
# Stage 2: Build TypeScript
# ---------------------------------------------------------------------------
FROM deps AS build

# Copy source code
COPY mcp-servers/mcp-portfolio-docs/src mcp-servers/mcp-portfolio-docs/src
COPY mcp-servers/mcp-portfolio-docs/tsconfig.json mcp-servers/mcp-portfolio-docs/tsconfig.json

# Compile TypeScript → dist/
RUN cd mcp-servers/mcp-portfolio-docs && yarn build

# ---------------------------------------------------------------------------
# Stage 3: Production runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

WORKDIR /app

# Copy workspace manifests for production install
COPY package.json yarn.lock .yarnrc.yml ./
COPY mcp-servers/mcp-portfolio-docs/package.json mcp-servers/mcp-portfolio-docs/package.json

# Install production dependencies only
RUN yarn workspaces focus @portfolio/mcp-portfolio-docs --production \
    && yarn cache clean

# Copy compiled output from build stage
COPY --from=build /app/mcp-servers/mcp-portfolio-docs/dist mcp-servers/mcp-portfolio-docs/dist

WORKDIR /app/mcp-servers/mcp-portfolio-docs

# MCP uses stdio — no ports to expose
ENTRYPOINT ["node", "dist/index.js"]
