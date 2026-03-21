/**
 * @fileoverview Predefined solo-operator runbook scenarios.
 *
 * Each scenario maps a failure trigger to the automatic response
 * mechanisms implemented in the project, plus manual verification steps.
 * No escalation — framed for a solo developer operating own infrastructure.
 *
 * @module data/runbook-scenarios
 */

import type { RunbookScenario } from '../types/index.js';

/** Predefined runbook scenarios with evidence mappings. */
export const RUNBOOK_SCENARIOS: readonly RunbookScenario[] = [
  {
    id: 'instance-terminated',
    title: 'EC2 Instance Terminated Unexpectedly',
    trigger: 'An EC2 worker node is terminated (spot reclaim, health check failure, or manual error).',
    autoResponseEvidence: [
      '**/step-function*',
      '**/state-machine*',
      '**/health*',
      '.github/workflows/*',
    ],
    manualChecks: [
      'Verify ASG has launched a replacement instance',
      'Confirm the new node has joined the Kubernetes cluster (kubectl get nodes)',
      'Check ArgoCD sync status for all applications',
      'Verify pods have been rescheduled onto the new node',
    ],
    recoveryEvidence: [
      '**/monitoring*',
      '**/dashboards/**',
      '**/argocd-apps/**',
    ],
  },
  {
    id: 'pod-crashloop',
    title: 'Pod CrashLoopBackOff',
    trigger: 'A pod enters CrashLoopBackOff state, repeatedly failing health checks.',
    autoResponseEvidence: [
      '**/deployment.yaml',
      '**/values.yaml',
      '**/golden-path*',
    ],
    manualChecks: [
      'Check pod logs (kubectl logs <pod> --previous)',
      'Verify resource limits are not causing OOMKill (kubectl describe pod)',
      'Check if a recent deployment caused the regression (ArgoCD history)',
      'Verify dependent services are healthy (DynamoDB, S3, external APIs)',
    ],
    recoveryEvidence: [
      '**/monitoring*',
      '**/argocd-apps/**',
    ],
  },
  {
    id: 'certificate-expiry',
    title: 'TLS Certificate Approaching Expiry',
    trigger: 'cert-manager fails to renew a TLS certificate, or a certificate is within 7 days of expiry.',
    autoResponseEvidence: [
      '**/cert-manager*',
      '**/cluster-issuer*',
      '**/ingress*',
    ],
    manualChecks: [
      'Check cert-manager logs for renewal failures (kubectl logs -n cert-manager)',
      'Verify ClusterIssuer is correctly configured (kubectl describe clusterissuer)',
      'Check DNS records point to the correct load balancer',
      'Verify Route 53 or external DNS provider is accessible',
    ],
    recoveryEvidence: [
      '**/cert-manager*',
      '**/edge-stack*',
    ],
  },
  {
    id: 'budget-alert',
    title: 'AWS Budget Threshold Exceeded',
    trigger: 'AWS Budget alert fires — actual or forecasted spend exceeds the configured threshold.',
    autoResponseEvidence: [
      '**/finops*',
      '**/budget*',
      '**/opencost*',
    ],
    manualChecks: [
      'Review AWS Cost Explorer for the top cost drivers',
      'Check OpenCost dashboard for Kubernetes workload cost attribution',
      'Identify any unexpected resources (orphaned EBS volumes, idle instances)',
      'Review recent deployments that may have increased resource usage',
    ],
    recoveryEvidence: [
      '**/finops*',
      '**/dashboards/**',
    ],
  },
] as const;
