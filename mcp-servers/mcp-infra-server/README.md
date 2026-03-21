# mcp-infra-server

A **unified Model Context Protocol (MCP) server** that bridges AI tools to both Kubernetes cluster operations and Next.js application diagnostics — 19 tools in a single server process.

## What is this?

This package combines infrastructure-level Kubernetes management with application-level AWS diagnostics into one MCP server, communicating over **stdio** with any MCP-compatible AI assistant.

```
┌────────────────┐                         ┌──────────────────┐
│  Antigravity   │                         │  K8s API Server  │
│  / AI Tool     │◄── stdio (MCP) ──►     │                  │
│                │                    ┌───►└──────────────────┘
└────────────────┘                    │
                                      │     ┌──────────────────┐
                              ┌───────┤     │  AWS APIs        │
                              │ mcp-  ├───► │  DynamoDB / SES  │
                              │ infra │     │  SSM / HTTP      │
                              │ server│     └──────────────────┘
                              └───────┘
```

## Security Model

- **Zero credential storage** — K8s auth via kubeconfig, AWS auth via the SDK default credential chain
- **RBAC-respecting** — K8s operations use the configured user's permissions
- **Read-only AWS by default** — only `test-subscription` performs a write (tagged `source: mcp-test`)
- **No SecureString decryption** — SSM lookups never decrypt secure values
- **Write operations** are clearly marked `⚠️ WRITE OPERATION` for AI confirmation prompts

## Available Tools (19)

### Kubernetes — Read Operations (7)

| Tool | Description |
|---|---|
| `list_namespaces` | List all cluster namespaces with status and age |
| `list_resources` | List any resource by apiVersion/kind with selectors |
| `get_resource` | Retrieve a single resource (full JSON) |
| `describe_resource` | kubectl describe-style output |
| `get_pod_logs` | Pod logs with tail, previous container, time filtering |
| `get_events` | Cluster events by namespace or object |
| `get_cluster_info` | Context, server URL, node summary |

### Kubernetes — Write Operations (5) ⚠️

| Tool | Description |
|---|---|
| `apply_resource` | Create or update resources from YAML/JSON |
| `delete_resource` | Delete resources with grace period |
| `exec_in_pod` | Execute commands in containers |
| `scale_resource` | Scale Deployments, StatefulSets, ReplicaSets |
| `manage_helm` | List, install, or uninstall Helm releases |

### AWS — Data Layer (3)

| Tool | Description |
|---|---|
| `query-dynamo` | Query or scan DynamoDB with key conditions, GSI, limits |
| `describe-dynamo` | Table schema, GSIs, item count, encryption |
| `get-ssm-parameters` | Discover infrastructure references by SSM path prefix |

### AWS — API & Networking (1)

| Tool | Description |
|---|---|
| `test-api-endpoint` | HTTP request → status, headers, body |

### AWS — Email Subscriptions (3)

| Tool | Description |
|---|---|
| `list-subscriptions` | List subscriptions filtered by status |
| `test-subscription` | Full POST → DynamoDB verification workflow |
| `check-ses-identity` | SES identity status + sending quota |

## Quick Start

### 1. Build

```bash
cd mcp-infra-server
yarn install
yarn build
# or via justfile:
just mcp-build
```

### 2. Configure Antigravity

In `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "mcp-infra-server": {
      "command": "node",
      "args": ["/path/to/mcp-infra-server/dist/index.js"],
      "env": {
        "KUBECONFIG": "/path/to/.kube/config",
        "AWS_PROFILE": "dev-account",
        "AWS_REGION": "eu-west-1"
      }
    }
  }
}
```

### 3. Discover Resources

Use `get-ssm-parameters` to find your infrastructure:

```
/nextjs/development  → image-uri, assets-bucket-name, aws-region
/bedrock-dev         → content-table-name, api-url, agent-arn, ...
```

## Project Structure

```
mcp-infra-server/
├── src/
│   ├── index.ts                 # Entry point — registers all 19 tools
│   ├── clients/
│   │   ├── k8s-client.ts        # K8s client factory (kubeconfig)
│   │   ├── aws-client.ts        # AWS SDK client factory (DDB, SES, SSM)
│   │   └── index.ts
│   ├── schemas/
│   │   ├── k8s-params.ts        # Zod schemas for K8s tools
│   │   ├── aws-params.ts        # Zod schemas for AWS tools
│   │   └── index.ts
│   ├── tools/
│   │   ├── k8s/                 # 12 Kubernetes tool handlers
│   │   ├── aws/                 # 7 AWS tool handlers
│   │   └── index.ts
│   └── utils/
│       ├── k8s-format.ts        # K8s output formatting
│       ├── k8s-error.ts         # K8s error → MCP mapping
│       ├── aws-format.ts        # DDB/HTTP/SSM output formatting
│       ├── aws-error.ts         # AWS error → MCP mapping
│       └── index.ts
├── package.json
├── tsconfig.json
├── jest.config.js
└── .gitignore
```

## Development

```bash
# Type-check
yarn lint

# Run in dev mode (tsx, no build step)
yarn dev

# Build
yarn build

# Run tests
yarn test
```

## Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server and stdio transport |
| `@kubernetes/client-node` | Typed K8s API client |
| `@aws-sdk/client-dynamodb` | DynamoDB DescribeTable |
| `@aws-sdk/lib-dynamodb` | DynamoDB document client |
| `@aws-sdk/client-ses` | SES identity checks |
| `@aws-sdk/client-ssm` | SSM parameter discovery |
| `zod` | Input schema validation |
| `js-yaml` | YAML manifest parsing |
