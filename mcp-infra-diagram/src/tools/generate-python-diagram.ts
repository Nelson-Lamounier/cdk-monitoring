/**
 * @fileoverview MCP tool: generate-python-diagram
 *
 * Discovers live infrastructure and generates a Python script using
 * the `diagrams` library. The script can be executed to produce a
 * PNG architecture diagram with AWS/K8s provider icons.
 *
 * @module tools/generate-python-diagram
 */

import { writeFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AwsClients } from '../clients/aws-client.js';
import type { K8sClients } from '../clients/k8s-client.js';
import { GeneratePythonDiagramSchema } from '../schemas/tool-params.js';
import { buildInfraGraph } from '../graph/resource-graph.js';
import { renderPythonDiagram } from '../renderers/python-renderer.js';
import { formatAwsError } from '../utils/helpers.js';

/**
 * Registers the `generate-python-diagram` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param awsClients - AWS SDK clients.
 * @param k8sClients - Optional K8s clients.
 */
export function registerGeneratePythonDiagram(
  server: McpServer,
  awsClients: AwsClients,
  k8sClients: K8sClients | undefined,
): void {
  server.tool(
    'generate-python-diagram',
    'Discover live AWS/K8s infrastructure and generate a Python `diagrams` library script. The script produces a PNG architecture diagram with AWS and Kubernetes provider icons when executed with `python <outputPath>`.',
    GeneratePythonDiagramSchema.shape,
    async (params) => {
      try {
        const graph = await buildInfraGraph(awsClients, k8sClients, {
          region: params.region,
          vpcId: params.vpcId,
          tags: params.tags,
          includeK8s: params.includeK8s,
          scope: params.scope,
        });

        const script = renderPythonDiagram(graph, params.outputPath);

        // Write the Python script to disk
        await writeFile(params.outputPath, script, 'utf-8');

        const summary = [
          `## Python Diagram Script Generated`,
          `- **Output:** \`${params.outputPath}\``,
          `- **Resources:** ${graph.nodes.length}`,
          `- **Relationships:** ${graph.edges.length}`,
          `- **Region:** ${graph.region}`,
          '',
          'To generate the PNG, run:',
          '```bash',
          `python ${params.outputPath}`,
          '```',
          '',
          'Requirements: `pip install diagrams` and `graphviz` installed.',
          '',
          '### Generated Script',
          '```python',
          script,
          '```',
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsError(error, 'generate-python-diagram') },
          ],
          isError: true,
        };
      }
    },
  );
}
