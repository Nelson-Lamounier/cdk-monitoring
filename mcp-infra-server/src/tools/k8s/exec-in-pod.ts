/**
 * @fileoverview MCP tool handler: exec_in_pod
 * Executes a command inside a running container.
 * ⚠️ Write operation — can modify container state.
 *
 * @module tools/exec-in-pod
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';
import * as stream from 'node:stream';

const execInPodInputSchema = {
  name: z.string().describe('Name of the pod'),
  namespace: z.string().describe('Namespace of the pod'),
  command: z.array(z.string()).min(1).describe(
    'Command to execute as an array. First element is the command, rest are arguments. Example: ["ls", "-la", "/tmp"]',
  ),
  container: z.string().optional().describe('Container name (required if pod has multiple containers)'),
};

/**
 * Registers the `exec_in_pod` tool with the MCP server.
 * ⚠️ This can modify container state.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerExecInPod(server: McpServer, clients: K8sClients): void {
  server.tool(
    'exec_in_pod',
    '⚠️ WRITE OPERATION: Execute a command inside a running Kubernetes pod container. Can modify container state — confirm with the user.',
    execInPodInputSchema,
    async (params) => {
      const { name, namespace, command, container } = params;
      const cmdStr = command.join(' ');
      const operationDesc = `executing "${cmdStr}" in pod ${name}/${namespace}`;

      try {
        const exec = new k8s.Exec(clients.kubeConfig);

        const stdout = new WritableCollector();
        const stderr = new WritableCollector();

        await new Promise<void>((resolve, reject) => {
          exec.exec(
            namespace,
            name,
            container ?? '',
            command,
            stdout,
            stderr,
            null,  // stdin
            false, // tty
            (status) => {
              if (status.status === 'Success') {
                resolve();
              } else {
                const reason = status.message ?? 'Command execution failed';
                reject(new Error(reason));
              }
            },
          );
        });

        const stdoutStr = stdout.getData();
        const stderrStr = stderr.getData();

        const sections: string[] = [`=== Exec: ${cmdStr} in ${name}/${namespace} ===`];

        if (stdoutStr.trim()) {
          sections.push('');
          sections.push('--- stdout ---');
          sections.push(stdoutStr);
        }

        if (stderrStr.trim()) {
          sections.push('');
          sections.push('--- stderr ---');
          sections.push(stderrStr);
        }

        if (!stdoutStr.trim() && !stderrStr.trim()) {
          sections.push('');
          sections.push('(no output)');
        }

        return { content: [{ type: 'text', text: sections.join('\n') }] };
      } catch (error) {
        const k8sError = handleK8sError(error, operationDesc);
        return {
          content: [{ type: 'text', text: formatK8sErrorForMcp(k8sError) }],
          isError: true,
        };
      }
    },
  );
}

/**
 * A writable stream that collects all written data into a buffer.
 * Used to capture stdout/stderr from kubectl exec.
 */
class WritableCollector extends stream.Writable {
  private readonly chunks: Buffer[] = [];

  /**
   * Internal write implementation.
   *
   * @param chunk - Data chunk to write.
   * @param _encoding - Character encoding (ignored for buffers).
   * @param callback - Callback to signal write completion.
   */
  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(chunk);
    callback();
  }

  /**
   * Returns all collected data as a UTF-8 string.
   *
   * @returns The concatenated output string.
   */
  getData(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }
}
