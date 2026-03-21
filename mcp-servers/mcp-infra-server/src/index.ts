#!/usr/bin/env node

/**
 * @fileoverview MCP Infrastructure Server — Unified Entry Point
 *
 * A single Model Context Protocol (MCP) server that bridges AI tools to both:
 * - A self-hosted Kubernetes API server (12 tools)
 * - AWS application diagnostics: DynamoDB, SES, SSM, API Gateway (7 tools)
 *
 * The server initialises both client factories and registers all 19 tools,
 * providing a unified diagnostic surface via stdio.
 *
 * K8s clients are lazy-loaded: the server automatically re-reads the kubeconfig
 * from disk when the file changes, so credentials are always fresh without
 * requiring a server restart.
 *
 * @example Start the server:
 * ```bash
 * node dist/index.js
 * ```
 *
 * @module index
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLazyK8sClients } from './clients/k8s-client.js';
import { createAwsClients } from './clients/aws-client.js';

// K8s tools
import {
  registerListNamespaces,
  registerListResources,
  registerGetResource,
  registerDescribeResource,
  registerApplyResource,
  registerDeleteResource,
  registerGetPodLogs,
  registerExecInPod,
  registerScaleResource,
  registerGetEvents,
  registerGetClusterInfo,
  registerManageHelm,
} from './tools/k8s/index.js';

// AWS tools
import {
  registerQueryDynamo,
  registerDescribeDynamo,
  registerTestApiEndpoint,
  registerListSubscriptions,
  registerTestSubscription,
  registerCheckSesIdentity,
  registerGetSsmParameters,
} from './tools/aws/index.js';

/** MCP server name and version for protocol identification. */
const SERVER_NAME = 'mcp-infra-server';
const SERVER_VERSION = '1.0.0';
const K8S_TOOL_COUNT = 12;
const AWS_TOOL_COUNT = 7;
const TOTAL_TOOLS = K8S_TOOL_COUNT + AWS_TOOL_COUNT;

/**
 * Initialises and starts the unified MCP infrastructure server.
 *
 * 1. Creates typed Kubernetes clients from the system kubeconfig
 * 2. Creates typed AWS SDK v3 clients for DynamoDB, SES, SSM
 * 3. Instantiates the MCP server with metadata
 * 4. Registers all 19 tool handlers (12 K8s + 7 AWS)
 * 5. Connects to the stdio transport for AI tool communication
 * 6. Sets up graceful shutdown handlers
 *
 * @throws Error if the kubeconfig cannot be loaded or the K8s API is unreachable.
 */
async function main(): Promise<void> {
  // Initialise Kubernetes clients (lazy-reload: re-reads kubeconfig when the file changes)
  const kubeconfigPath = process.env.KUBECONFIG;
  const k8sClients = createLazyK8sClients(kubeconfigPath);

  // Initialise AWS clients
  const awsClients = createAwsClients();

  // Create the MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register K8s tool handlers (12)
  registerListNamespaces(server, k8sClients);
  registerListResources(server, k8sClients);
  registerGetResource(server, k8sClients);
  registerDescribeResource(server, k8sClients);
  registerApplyResource(server, k8sClients);
  registerDeleteResource(server, k8sClients);
  registerGetPodLogs(server, k8sClients);
  registerExecInPod(server, k8sClients);
  registerScaleResource(server, k8sClients);
  registerGetEvents(server, k8sClients);
  registerGetClusterInfo(server, k8sClients);
  registerManageHelm(server, k8sClients);

  // Register AWS tool handlers (7)
  registerQueryDynamo(server, awsClients);
  registerDescribeDynamo(server, awsClients);
  registerTestApiEndpoint(server, awsClients);
  registerListSubscriptions(server, awsClients);
  registerTestSubscription(server, awsClients);
  registerCheckSesIdentity(server, awsClients);
  registerGetSsmParameters(server, awsClients);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol messages)
  process.stderr.write(
    `${SERVER_NAME} v${SERVER_VERSION} started. ${TOTAL_TOOLS} tools registered (${K8S_TOOL_COUNT} K8s + ${AWS_TOOL_COUNT} AWS).\n`,
  );

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    process.stderr.write('Shutting down MCP server...\n');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
