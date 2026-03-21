#!/usr/bin/env node

/**
 * @fileoverview MCP Infrastructure Diagram Server — Entry Point
 *
 * A Model Context Protocol (MCP) server that discovers live AWS and
 * Kubernetes resources and generates architecture diagrams from the
 * actual deployed infrastructure — not from CDK source code.
 *
 * Provides 4 tools:
 * - `discover-infrastructure` — scan resources, return JSON graph
 * - `generate-mermaid-diagram` — scan resources, return Mermaid string
 * - `generate-python-diagram` — scan resources, write Python `diagrams` script
 * - `generate-infra-doc` — scan resources, generate structured documentation
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
import { createAwsClients } from './clients/aws-client.js';
import { createK8sClients } from './clients/k8s-client.js';
import type { K8sClients } from './clients/k8s-client.js';
import {
  registerDiscoverInfrastructure,
  registerGenerateMermaid,
  registerGeneratePythonDiagram,
  registerGenerateInfraDoc,
} from './tools/index.js';

/** MCP server name and version for protocol identification. */
const SERVER_NAME = 'mcp-infra-diagram';
const SERVER_VERSION = '1.0.0';
const TOOL_COUNT = 4;

/**
 * Initialises and starts the MCP infrastructure diagram server.
 *
 * 1. Creates typed AWS SDK v3 clients for resource discovery
 * 2. Optionally creates K8s API clients (non-fatal if unavailable)
 * 3. Instantiates the MCP server with metadata
 * 4. Registers all 4 tool handlers
 * 5. Connects to the stdio transport for AI tool communication
 * 6. Sets up graceful shutdown handlers
 */
async function main(): Promise<void> {
  // Initialise AWS clients
  const awsClients = createAwsClients();

  // Initialise K8s clients (optional — server works without K8s)
  let k8sClients: K8sClients | undefined;
  try {
    const kubeconfigPath = process.env.KUBECONFIG;
    k8sClients = createK8sClients(kubeconfigPath);
    process.stderr.write('K8s clients initialised from kubeconfig.\n');
  } catch (error) {
    process.stderr.write(
      `K8s clients unavailable (K8s discovery will be skipped): ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  // Create the MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register tool handlers
  registerDiscoverInfrastructure(server, awsClients, k8sClients);
  registerGenerateMermaid(server, awsClients, k8sClients);
  registerGeneratePythonDiagram(server, awsClients, k8sClients);
  registerGenerateInfraDoc(server, awsClients, k8sClients);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `${SERVER_NAME} v${SERVER_VERSION} started. ${TOOL_COUNT} tools registered. ` +
    `AWS region: ${awsClients.region}. K8s: ${k8sClients ? 'enabled' : 'disabled'}.\n`,
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
  process.stderr.write(
    `Fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
