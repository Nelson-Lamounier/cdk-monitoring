/**
 * @format
 * EKS Karpenter Stack — SQS interruption queue + EventBridge wiring +
 * NodePool/EC2NodeClass CRDs.
 *
 * The Karpenter Helm chart is installed by EksAddonsStack; this stack
 * supplies the runtime data plane (queue, CRDs).
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md §§ 3.2, 3.3
 */
import { NagSuppressions } from 'cdk-nag';

import * as eks from 'aws-cdk-lib/aws-eks';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { EksKarpenterNodePoolConfig, EksKarpenterSystemPoolConfig } from '../../config/eks';
import { Environment } from '../../config/environments';

export interface EksKarpenterStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly workerNodeRole: iam.IRole;
    readonly subnetTagKey: string;
    readonly karpenter: EksKarpenterNodePoolConfig;
    /**
     * Optional elastic system-tier NodePool. When defined, renders a second
     * EC2NodeClass + NodePool tainted `dedicated=system:NoSchedule` and
     * labelled `node-role=system`, weight 10 so the scheduler prefers it
     * over the workload pool for tolerating pods.
     */
    readonly systemPool?: EksKarpenterSystemPoolConfig;
}

export class EksKarpenterStack extends cdk.Stack {
    public readonly interruptionQueue: sqs.Queue;

    constructor(scope: Construct, id: string, props: EksKarpenterStackProps) {
        super(scope, id, props);

        this.interruptionQueue = new sqs.Queue(this, 'InterruptionQueue', {
            queueName: `${props.cluster.clusterName}-karpenter`,
            retentionPeriod: cdk.Duration.minutes(5),
            enforceSSL: true,
        });
        this.interruptionQueue.addToResourcePolicy(
            new iam.PolicyStatement({
                principals: [
                    new iam.ServicePrincipal('events.amazonaws.com'),
                    new iam.ServicePrincipal('sqs.amazonaws.com'),
                ],
                actions: ['sqs:SendMessage'],
                resources: [this.interruptionQueue.queueArn],
            }),
        );
        // Interruption messages are ephemeral signals consumed by Karpenter;
        // a DLQ adds operational complexity without recovery value (5-min TTL
        // means lost messages are stale by the time a DLQ would help).
        NagSuppressions.addResourceSuppressions(this.interruptionQueue, [
            {
                id: 'AwsSolutions-SQS3',
                reason: 'Karpenter interruption queue: 5-minute retention; DLQ adds no value for ephemeral signals.',
            },
        ]);

        const ruleSpecs: { id: string; source: string; detailType: string }[] = [
            { id: 'SpotInterruption', source: 'aws.ec2', detailType: 'EC2 Spot Instance Interruption Warning' },
            { id: 'ScheduledChange', source: 'aws.health', detailType: 'AWS Health Event' },
            { id: 'InstanceTerminating', source: 'aws.ec2', detailType: 'EC2 Instance State-change Notification' },
            { id: 'RebalanceRecommendation', source: 'aws.ec2', detailType: 'EC2 Instance Rebalance Recommendation' },
        ];
        for (const r of ruleSpecs) {
            new events.Rule(this, `Rule${r.id}`, {
                eventPattern: { source: [r.source], detailType: [r.detailType] },
                targets: [new eventsTargets.SqsQueue(this.interruptionQueue)],
            });
        }

        // Apply EC2NodeClass + NodePool as Kubernetes manifests.
        // Role name (not ARN) is required by Karpenter EC2NodeClass.spec.role.
        // prune: false — CDK must never issue `kubectl delete` on these CRDs.
        // Karpenter sets a `karpenter.k8s.aws/termination` finalizer that
        // requires the controller to be running to process. Since EksAddonsStack
        // (Helm install) is destroyed after this stack, the controller exits
        // before the finalizer can be cleared, leaving the object stuck
        // Terminating on the next deploy. With prune:false, CDK only applies
        // (creates/updates) — Karpenter owns the delete lifecycle.
        new eks.KubernetesManifest(this, 'EC2NodeClass', {
            cluster: props.cluster,
            prune: false,
            manifest: [
                {
                    apiVersion: 'karpenter.k8s.aws/v1',
                    kind: 'EC2NodeClass',
                    metadata: { name: 'workloads-default-class' },
                    spec: {
                        // Karpenter v1 requires amiSelectorTerms. The AL2023
                        // alias resolves to the EKS-optimized AL2023 AMI for
                        // the cluster's Kubernetes version automatically.
                        amiFamily: 'AL2023',
                        amiSelectorTerms: [{ alias: 'al2023@latest' }],
                        role: cdk.Fn.select(1, cdk.Fn.split('/', props.workerNodeRole.roleArn)),
                        subnetSelectorTerms: [{ tags: { [props.subnetTagKey]: 'shared' } }],
                        // Tag-based SG discovery — selects the EKS-managed
                        // cluster SG at node launch time. EKS auto-tags it
                        // `kubernetes.io/cluster/<name>: owned` on cluster
                        // create. The cluster SG already carries:
                        //   - all-traffic self-referencing rule (node-to-node)
                        //   - control-plane ↔ kubelet rules (:10250)
                        // No pre-provisioned CDK SG required.
                        securityGroupSelectorTerms: [
                            { tags: { [`kubernetes.io/cluster/${props.cluster.clusterName}`]: 'owned' } },
                        ],
                        // IMDSv2 hop limit 2: pods run inside a Linux network
                        // bridge (veth pair), which adds one hop vs. the host.
                        // Default hop limit of 1 drops IMDS requests from pods,
                        // preventing AWS SDK credential resolution via IMDS.
                        metadataOptions: {
                            httpEndpoint: 'enabled',
                            httpProtocolIPv6: 'disabled',
                            httpPutResponseHopLimit: 2,
                            httpTokens: 'required',
                        },
                        tags: {
                            'eks-cluster-pool': 'workloads-default',
                            // Human-readable name visible in AWS Console EC2 inventory.
                            Name: 'k8s-eks-workload',
                        },
                    },
                },
            ],
        });

        if (props.systemPool) {
            const sys = props.systemPool;
            new eks.KubernetesManifest(this, 'SystemEC2NodeClass', {
                cluster: props.cluster,
                prune: false,
                manifest: [
                    {
                        apiVersion: 'karpenter.k8s.aws/v1',
                        kind: 'EC2NodeClass',
                        metadata: { name: 'system-class' },
                        spec: {
                            amiFamily: 'AL2023',
                            amiSelectorTerms: [{ alias: 'al2023@latest' }],
                            role: cdk.Fn.select(1, cdk.Fn.split('/', props.workerNodeRole.roleArn)),
                            subnetSelectorTerms: [{ tags: { [props.subnetTagKey]: 'shared' } }],
                            // Same tag-based SG discovery as the workload
                            // EC2NodeClass — selects the EKS-managed cluster
                            // SG (auto-tagged kubernetes.io/cluster/<name>:
                            // owned), which carries node-to-node + control-
                            // plane↔kubelet rules. No pre-provisioned CDK SG.
                            securityGroupSelectorTerms: [
                                { tags: { [`kubernetes.io/cluster/${props.cluster.clusterName}`]: 'owned' } },
                            ],
                            // IMDSv2 hop limit 2 — pods run behind a veth
                            // bridge (one extra hop); default limit 1 drops
                            // pod IMDS requests. Parity with workload class.
                            metadataOptions: {
                                httpEndpoint: 'enabled',
                                httpProtocolIPv6: 'disabled',
                                httpPutResponseHopLimit: 2,
                                httpTokens: 'required',
                            },
                            tags: {
                                'eks-cluster-pool': 'system',
                                Name: 'k8s-eks-system',
                            },
                        },
                    },
                ],
            });

            // System pool. Weight 10 (workload default 0) so the scheduler
            // prefers it for pods that tolerate the `dedicated=system` taint —
            // matters when a pod has no nodeSelector but does tolerate.
            // Pods select via `node-role=system` label, identical to MNG, so
            // ESO / cert-manager / etc. land on either MNG or this pool.
            new eks.KubernetesManifest(this, 'SystemNodePool', {
                cluster: props.cluster,
                prune: false,
                manifest: [
                    {
                        apiVersion: 'karpenter.sh/v1',
                        kind: 'NodePool',
                        metadata: { name: 'system' },
                        spec: {
                            weight: 10,
                            template: {
                                metadata: {
                                    labels: { 'node-role': 'system' },
                                },
                                spec: {
                                    taints: [
                                        { key: 'dedicated', value: 'system', effect: 'NoSchedule' },
                                    ],
                                    nodeClassRef: {
                                        group: 'karpenter.k8s.aws',
                                        kind: 'EC2NodeClass',
                                        name: 'system-class',
                                    },
                                    requirements: [
                                        {
                                            key: 'karpenter.k8s.aws/instance-family',
                                            operator: 'In',
                                            values: [...sys.instanceFamily],
                                        },
                                        {
                                            // t3 sizes share vCPU; size is the
                                            // memory discriminator. Karpenter picks
                                            // smallest fitting then consolidates up.
                                            key: 'karpenter.k8s.aws/instance-size',
                                            operator: 'In',
                                            values: [...sys.instanceSizes],
                                        },
                                        {
                                            key: 'karpenter.sh/capacity-type',
                                            operator: 'In',
                                            values: [...sys.capacityType],
                                        },
                                        {
                                            key: 'kubernetes.io/arch',
                                            operator: 'In',
                                            values: [...sys.architectures],
                                        },
                                    ],
                                    expireAfter: '720h',
                                },
                            },
                            disruption: {
                                consolidationPolicy: 'WhenEmptyOrUnderutilized',
                                consolidateAfter: '1m',
                            },
                            limits: { cpu: sys.cpuLimit },
                        },
                    },
                ],
            });
        }

        new eks.KubernetesManifest(this, 'NodePool', {
            cluster: props.cluster,
            prune: false,
            manifest: [
                {
                    apiVersion: 'karpenter.sh/v1',
                    kind: 'NodePool',
                    metadata: { name: 'workloads-default' },
                    spec: {
                        template: {
                            metadata: {
                                // Exposes as label_node_role in kube-state-metrics,
                                // matching the MNG node labelling convention and
                                // the Grafana cluster dashboard filter variable.
                                labels: { 'node-role': 'workload' },
                            },
                            spec: {
                                nodeClassRef: {
                                    group: 'karpenter.k8s.aws',
                                    kind: 'EC2NodeClass',
                                    name: 'workloads-default-class',
                                },
                                requirements: [
                                    {
                                        key: 'karpenter.k8s.aws/instance-category',
                                        operator: 'In',
                                        values: [...props.karpenter.instanceCategory],
                                    },
                                    {
                                        key: 'karpenter.k8s.aws/instance-family',
                                        operator: 'In',
                                        values: [...props.karpenter.instanceFamily],
                                    },
                                    {
                                        key: 'karpenter.sh/capacity-type',
                                        operator: 'In',
                                        values: [...props.karpenter.capacityType],
                                    },
                                    {
                                        key: 'kubernetes.io/arch',
                                        operator: 'In',
                                        values: [...props.karpenter.architectures],
                                    },
                                    {
                                        key: 'karpenter.k8s.aws/instance-cpu',
                                        operator: 'Gt',
                                        values: [String(props.karpenter.cpuMin - 1)],
                                    },
                                    {
                                        key: 'karpenter.k8s.aws/instance-cpu',
                                        operator: 'Lt',
                                        values: [String(props.karpenter.cpuMax + 1)],
                                    },
                                ],
                                expireAfter: '720h',
                            },
                        },
                        disruption: {
                            // WhenEmptyOrUnderutilized actively bin-packs: evicts pods
                            // from underutilised nodes so they can be deleted.
                            // WhenEmpty (previous) only removed fully empty nodes,
                            // leaving underutilised nodes permanently running.
                            consolidationPolicy: 'WhenEmptyOrUnderutilized',
                            consolidateAfter: '1m',
                        },
                        limits: { cpu: 100 },
                    },
                },
            ],
        });
    }
}
