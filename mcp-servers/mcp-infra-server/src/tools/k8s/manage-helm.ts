/**
 * @fileoverview MCP tool handler: manage_helm
 * Lists, installs, and uninstalls Helm releases by shelling out to the `helm` CLI.
 * Requires `helm` to be available on the system PATH.
 *
 * @module tools/manage-helm
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const manageHelmInputSchema = {
  action: z.enum(['list', 'install', 'uninstall']).describe(
    'Helm action to perform: list releases, install a chart, or uninstall a release.',
  ),
  namespace: z.string().optional().describe('Namespace for the Helm operation.'),
  releaseName: z.string().optional().describe('Release name (required for install/uninstall).'),
  chart: z.string().optional().describe(
    'Chart reference for install (e.g. "stable/grafana", "oci://ghcr.io/chart"). Required for install.',
  ),
  values: z.string().optional().describe(
    'YAML string of values to pass to helm install (equivalent to -f values.yaml).',
  ),
  allNamespaces: z.boolean().default(false).optional().describe(
    'For list action: list releases across all namespaces.',
  ),
};

/**
 * Registers the `manage_helm` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param _clients - The Kubernetes API clients (unused — Helm uses its own kubeconfig).
 */
export function registerManageHelm(server: McpServer, _clients: K8sClients): void {
  server.tool(
    'manage_helm',
    'Manage Helm releases: list deployed charts, install new ones, or uninstall existing releases. Requires helm CLI on the system PATH.',
    manageHelmInputSchema,
    async (params) => {
      const { action, namespace, releaseName, chart, values, allNamespaces } = params;

      try {
        switch (action) {
          case 'list':
            return await helmList(namespace, allNamespaces);
          case 'install':
            return await helmInstall(releaseName, chart, namespace, values);
          case 'uninstall':
            return await helmUninstall(releaseName, namespace);
          default:
            return {
              content: [{ type: 'text' as const, text: `Unknown helm action: ${action}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Helm error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Lists Helm releases.
 */
async function helmList(
  namespace?: string,
  allNamespaces?: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const args = ['list', '--output', 'table'];

  if (allNamespaces) {
    args.push('--all-namespaces');
  } else if (namespace) {
    args.push('--namespace', namespace);
  }

  const { stdout } = await execFileAsync('helm', args, { timeout: 30000 });

  if (!stdout.trim()) {
    return { content: [{ type: 'text', text: 'No Helm releases found.' }] };
  }

  return { content: [{ type: 'text', text: `=== Helm Releases ===\n\n${stdout}` }] };
}

/**
 * Installs a Helm chart.
 */
async function helmInstall(
  releaseName?: string,
  chart?: string,
  namespace?: string,
  values?: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!releaseName) {
    return {
      content: [{ type: 'text', text: 'Error: releaseName is required for helm install.' }],
      isError: true,
    } as { content: Array<{ type: 'text'; text: string }> };
  }

  if (!chart) {
    return {
      content: [{ type: 'text', text: 'Error: chart is required for helm install.' }],
      isError: true,
    } as { content: Array<{ type: 'text'; text: string }> };
  }

  const args = ['install', releaseName, chart];

  if (namespace) {
    args.push('--namespace', namespace, '--create-namespace');
  }

  if (values) {
    // Write values to a temp file
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpFile = path.join(os.tmpdir(), `helm-values-${Date.now()}.yaml`);
    await fs.writeFile(tmpFile, values, 'utf-8');
    args.push('-f', tmpFile);
  }

  const { stdout, stderr } = await execFileAsync('helm', args, { timeout: 120000 });
  const output = stdout || stderr;

  return {
    content: [{ type: 'text', text: `✓ Helm install complete:\n\n${output}` }],
  };
}

/**
 * Uninstalls a Helm release.
 */
async function helmUninstall(
  releaseName?: string,
  namespace?: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!releaseName) {
    return {
      content: [{ type: 'text', text: 'Error: releaseName is required for helm uninstall.' }],
      isError: true,
    } as { content: Array<{ type: 'text'; text: string }> };
  }

  const args = ['uninstall', releaseName];

  if (namespace) {
    args.push('--namespace', namespace);
  }

  const { stdout, stderr } = await execFileAsync('helm', args, { timeout: 60000 });
  const output = stdout || stderr;

  return {
    content: [{ type: 'text', text: `✓ Helm uninstall complete:\n\n${output}` }],
  };
}
