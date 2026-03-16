/**
 * @format
 * Kubernetes Base Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesBaseStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that all resources exist, are correctly
 * configured, and the environment is ready for downstream stacks
 * (GoldenAMI, Compute, AppIam, Api, Edge).
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by the base stack
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development
 */

import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { LogGroup } from '@aws-sdk/client-cloudwatch-logs';
import {
    EC2Client,
    DescribeVpcsCommand,
    DescribeSecurityGroupsCommand,
    DescribeVolumesCommand,
    DescribeAddressesCommand,
    DescribeFlowLogsCommand,
} from '@aws-sdk/client-ec2';
import type { IpPermission } from '@aws-sdk/client-ec2';
import type { FlowLog } from '@aws-sdk/client-ec2';
import {
    ElasticLoadBalancingV2Client,
    DescribeLoadBalancersCommand,
    DescribeTargetGroupsCommand,
    DescribeListenersCommand,
    DescribeLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { LoadBalancer, Listener, TargetGroup, LoadBalancerAttribute } from '@aws-sdk/client-elastic-load-balancing-v2';
import {
    KMSClient,
    DescribeKeyCommand,
    GetKeyRotationStatusCommand,
} from '@aws-sdk/client-kms';
import type { KeyMetadata } from '@aws-sdk/client-kms';
import {
    Route53Client,
    GetHostedZoneCommand,
    ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import type { HostedZone, ResourceRecordSet } from '@aws-sdk/client-route-53';
import {
    S3Client,
    HeadBucketCommand,
    GetBucketEncryptionCommand,
    GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';

import { Environment } from '../../../lib/config';
import { getK8sConfigs } from '../../../lib/config/kubernetes';
import { k8sSsmPaths, k8sSsmPrefix } from '../../../lib/config/ssm-paths';
import type { K8sSsmPaths } from '../../../lib/config/ssm-paths';
import { flatName } from '../../../lib/utilities/naming';

// =============================================================================
// Rule 4: Environment Variable Parsing — No Silent `as` Casts
// =============================================================================

/**
 * Parse and validate CDK_ENV environment variable.
 * Throws with a descriptive error for invalid values.
 */
function parseEnvironment(raw: string): Environment {
    const valid = [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION] as const satisfies readonly Environment[];
    if (!valid.includes(raw as Environment)) {
        throw new Error(`Invalid CDK_ENV: "${raw}". Expected one of: ${valid.join(', ')}`);
    }
    return raw as Environment;
}

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = parseEnvironment(process.env.CDK_ENV ?? 'development');
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const CONFIGS = getK8sConfigs(CDK_ENV);
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);
const NAME_PREFIX = flatName('k8s', '', CDK_ENV);

// =============================================================================
// Rule 3: Magic Values — Named Constants Only
// =============================================================================

// Networking
const VPC_CIDR_PREFIX = '10.';
const POD_CIDR_PREFIX = '192.168.';
const ANY_IPV4 = '0.0.0.0/0';

// Retention / lifecycle
const FLOW_LOG_RETENTION_DAYS = 3;
const NLB_LOG_LIFECYCLE_DAYS = 3;
const NLB_LOG_PREFIX = 'nlb-access-logs';
const API_RECORD_TTL = 30;
const K8S_INTERNAL_ZONE = 'k8s.internal.';
const K8S_API_FQDN = 'k8s-api.k8s.internal';
const K8S_API_FQDN_DOT = `${K8S_API_FQDN}.`;

// Listener count
const EXPECTED_LISTENER_COUNT = 2;

// AWS SDK clients (shared across tests)
const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const kms = new KMSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const route53 = new Route53Client({ region: REGION });
const elbv2 = new ElasticLoadBalancingV2Client({ region: REGION });
const cwl = new CloudWatchLogsClient({ region: REGION });

// =============================================================================
// Rule 2: Non-Null Assertions — Use a `requireParam` Helper
// =============================================================================

/**
 * Retrieve a required SSM parameter from the cached map.
 * Throws a descriptive error if the parameter is missing or empty.
 *
 * @param params - The SSM parameter Map<path, value>
 * @param path - The full SSM path to look up
 * @returns The parameter value (guaranteed non-empty)
 * @throws Error if the parameter is missing or empty
 */
function requireParam(params: Map<string, string>, path: string): string {
    const value = params.get(path);
    if (!value) throw new Error(`Missing required SSM parameter: ${path}`);
    return value;
}

// =============================================================================
// SSM Parameter Cache (loaded once at module level — Rule 1)
// =============================================================================

/**
 * Load all SSM parameters under the k8s prefix in one paginated call.
 * Returns a Map<path, value> for fast lookup.
 */
async function loadSsmParameters(): Promise<Map<string, string>> {
    const params = new Map<string, string>();
    let nextToken: string | undefined;

    do {
        const response = await ssm.send(
            new GetParametersByPathCommand({
                Path: PREFIX,
                Recursive: true,
                WithDecryption: true,
                NextToken: nextToken,
            }),
        );

        for (const param of response.Parameters ?? []) {
            if (param.Name && param.Value) {
                params.set(param.Name, param.Value);
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);

    return params;
}

// =============================================================================
// Helper: SG Rule Assertion Utilities (module-level — Rule 10)
// =============================================================================

/**
 * Find a TCP ingress rule matching a specific port (or port range).
 *
 * @param ingress - The IpPermissions array from DescribeSecurityGroups
 * @param fromPort - The start port to match
 * @param toPort - The end port to match (defaults to fromPort for single-port rules)
 */
function findTcpIngressRule(
    ingress: IpPermission[],
    fromPort: number,
    toPort?: number,
): IpPermission | undefined {
    return ingress.find(
        (r) => r.FromPort === fromPort
            && r.ToPort === (toPort ?? fromPort)
            && r.IpProtocol === 'tcp',
    );
}

/**
 * Find a UDP ingress rule matching a specific port.
 */
function findUdpIngressRule(
    ingress: IpPermission[],
    fromPort: number,
    toPort?: number,
): IpPermission | undefined {
    return ingress.find(
        (r) => r.FromPort === fromPort
            && r.ToPort === (toPort ?? fromPort)
            && r.IpProtocol === 'udp',
    );
}

/**
 * Assert that a rule has a self-referencing source (same SG ID).
 */
function expectSelfReferencing(rule: IpPermission, sgId: string): void {
    const selfRef = rule.UserIdGroupPairs?.find((p) => p.GroupId === sgId);
    expect(selfRef).toBeDefined();
}

/**
 * Assert that a rule has an IPv4 CIDR source containing the given prefix.
 */
function expectCidrSource(rule: IpPermission, cidrPrefix: string): void {
    const match = rule.IpRanges?.find((r) => r.CidrIp?.startsWith(cidrPrefix));
    expect(match).toBeDefined();
}

/**
 * Assert that a rule has a prefix list source.
 */
function expectPrefixListSource(rule: IpPermission): void {
    expect(rule.PrefixListIds?.length).toBeGreaterThan(0);
}

// =============================================================================
// Module-Level Cached State (Rule 1 + Rule 10)
//
// All shared API responses are fetched once in beforeAll and reused.
// =============================================================================

let ssmParams: Map<string, string>;

// NLB — fetched once, shared across NLB Config, NLB SG, NLB Access Logs
let nlb: LoadBalancer;
let nlbArn: string;
let nlbAttributes: LoadBalancerAttribute[];
let nlbListeners: Listener[];
let nlbLogBucketName: string;

// NLB Target Groups
let httpTargetGroup: TargetGroup;
let httpsTargetGroup: TargetGroup;

// NLB SG
let nlbSgIngress: IpPermission[];
let nlbSgEgress: IpPermission[];

// VPC Flow Logs
let flowLogs: FlowLog[];
let cwlFlowLog: FlowLog | undefined;
let flowLogGroup: LogGroup | undefined;

// =============================================================================
// Top-Level beforeAll — Fetch All Module-Level Resources Once (Rule 1)
// =============================================================================

beforeAll(async () => {
    // --- SSM Parameters (gate for everything else) ---
    ssmParams = await loadSsmParameters();

    // --- NLB ---
    const { LoadBalancers } = await elbv2.send(
        new DescribeLoadBalancersCommand({
            Names: [`${NAME_PREFIX}-nlb`],
        }),
    );
    expect(LoadBalancers).toHaveLength(1);
    nlb = LoadBalancers![0];
    nlbArn = nlb.LoadBalancerArn!;

    // NLB Attributes (access logs config)
    const { Attributes } = await elbv2.send(
        new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: nlbArn }),
    );
    nlbAttributes = Attributes ?? [];

    // NLB log bucket name from attributes
    nlbLogBucketName = nlbAttributes.find(
        (a) => a.Key === 'access_logs.s3.bucket',
    )?.Value ?? '';
    expect(nlbLogBucketName).toBeTruthy();

    // NLB Listeners
    const { Listeners } = await elbv2.send(
        new DescribeListenersCommand({ LoadBalancerArn: nlbArn }),
    );
    nlbListeners = Listeners ?? [];

    // NLB Target Groups
    const httpArn = requireParam(ssmParams, SSM_PATHS.nlbHttpTargetGroupArn);
    const httpsArn = requireParam(ssmParams, SSM_PATHS.nlbHttpsTargetGroupArn);

    const [httpTgResp, httpsTgResp] = await Promise.all([
        elbv2.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [httpArn] })),
        elbv2.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [httpsArn] })),
    ]);
    expect(httpTgResp.TargetGroups).toHaveLength(1);
    expect(httpsTgResp.TargetGroups).toHaveLength(1);
    httpTargetGroup = httpTgResp.TargetGroups![0];
    httpsTargetGroup = httpsTgResp.TargetGroups![0];

    // NLB SG — discovered from NLB, not SSM
    const nlbSgIds = nlb.SecurityGroups ?? [];
    expect(nlbSgIds.length).toBeGreaterThan(0);
    const { SecurityGroups: nlbSgs } = await ec2.send(
        new DescribeSecurityGroupsCommand({ GroupIds: [nlbSgIds[0]] }),
    );
    expect(nlbSgs).toHaveLength(1);
    nlbSgIngress = nlbSgs![0].IpPermissions ?? [];
    nlbSgEgress = nlbSgs![0].IpPermissionsEgress ?? [];

    // --- VPC Flow Logs ---
    const vpcId = requireParam(ssmParams, SSM_PATHS.vpcId);
    const { FlowLogs } = await ec2.send(
        new DescribeFlowLogsCommand({
            Filter: [{ Name: 'resource-id', Values: [vpcId] }],
        }),
    );
    flowLogs = FlowLogs ?? [];

    cwlFlowLog = flowLogs.find(
        (f) => f.LogDestinationType === 'cloud-watch-logs',
    );

    // Flow log group retention (only if CloudWatch flow log exists)
    if (cwlFlowLog?.LogGroupName) {
        const { logGroups } = await cwl.send(
            new DescribeLogGroupsCommand({
                logGroupNamePrefix: cwlFlowLog.LogGroupName,
            }),
        );
        flowLogGroup = logGroups?.find(
            (g) => g.logGroupName === cwlFlowLog!.LogGroupName,
        );
    }
});

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesBaseStack — Post-Deploy Verification', () => {
    // =========================================================================
    // SSM Parameters (14)
    // =========================================================================
    describe('SSM Parameters', () => {
        // Rule 5: Use `satisfies` instead of `as const`
        const expectedPaths = [
            'vpcId',
            'elasticIp',
            'elasticIpAllocationId',
            'securityGroupId',
            'controlPlaneSgId',
            'ingressSgId',
            'monitoringSgId',
            'ebsVolumeId',
            'scriptsBucket',
            'hostedZoneId',
            'apiDnsName',
            'kmsKeyArn',
            'nlbHttpTargetGroupArn',
            'nlbHttpsTargetGroupArn',
        ] satisfies Array<keyof K8sSsmPaths>;

        it('should have all 14 SSM parameters published', () => {
            expect(ssmParams.size).toBeGreaterThanOrEqual(expectedPaths.length);
        });

        it.each(expectedPaths)(
            'should have a non-empty value for %s',
            (key) => {
                const path = SSM_PATHS[key];
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.length).toBeGreaterThan(0);
            },
        );

        it('should store the K8s API FQDN as the API DNS name', () => {
            expect(requireParam(ssmParams, SSM_PATHS.apiDnsName)).toBe(
                K8S_API_FQDN,
            );
        });

        it('should have NLB target group ARNs in valid ARN format', () => {
            const httpArn = requireParam(ssmParams, SSM_PATHS.nlbHttpTargetGroupArn);
            const httpsArn = requireParam(ssmParams, SSM_PATHS.nlbHttpsTargetGroupArn);

            expect(httpArn).toMatch(/^arn:aws:elasticloadbalancing:/);
            expect(httpsArn).toMatch(/^arn:aws:elasticloadbalancing:/);
        });
    });

    // =========================================================================
    // VPC
    // =========================================================================
    describe('VPC', () => {
        it('should exist and be in available state', async () => {
            const vpcId = requireParam(ssmParams, SSM_PATHS.vpcId);

            const { Vpcs } = await ec2.send(
                new DescribeVpcsCommand({ VpcIds: [vpcId] }),
            );

            expect(Vpcs).toHaveLength(1);
            const vpc = Vpcs![0];
            expect(vpc.State).toBe('available');
        });
    });

    // =========================================================================
    // VPC Flow Logs
    // Depends on: flowLogs, cwlFlowLog, flowLogGroup populated in top-level beforeAll
    // =========================================================================
    describe('VPC Flow Logs', () => {
        it('should have flow logs enabled for the VPC', () => {
            expect(flowLogs.length).toBeGreaterThan(0);
        });

        it('should deliver flow logs to CloudWatch Logs', () => {
            expect(cwlFlowLog).toBeDefined();
            expect(cwlFlowLog!.FlowLogStatus).toBe('ACTIVE');
        });

        it('should have correct retention on CloudWatch log group', () => {
            expect(flowLogGroup).toBeDefined();
            expect(flowLogGroup!.retentionInDays).toBe(FLOW_LOG_RETENTION_DAYS);
        });
    });

    // =========================================================================
    // Security Groups — Existence & VPC Attachment (×4)
    // =========================================================================
    describe('Security Groups — Existence', () => {
        // Rule 5: Use `satisfies` for typed literals
        const sgKeys = [
            { key: 'securityGroupId', label: 'Cluster Base' },
            { key: 'controlPlaneSgId', label: 'Control Plane' },
            { key: 'ingressSgId', label: 'Ingress' },
            { key: 'monitoringSgId', label: 'Monitoring' },
        ] satisfies Array<{ key: keyof K8sSsmPaths; label: string }>;

        it.each(sgKeys)(
            'should exist and be attached to the VPC ($label SG)',
            async ({ key }) => {
                const sgId = requireParam(ssmParams, SSM_PATHS[key]);
                const vpcId = requireParam(ssmParams, SSM_PATHS.vpcId);

                const { SecurityGroups } = await ec2.send(
                    new DescribeSecurityGroupsCommand({
                        GroupIds: [sgId],
                    }),
                );

                expect(SecurityGroups).toHaveLength(1);
                const sg = SecurityGroups![0];
                expect(sg.VpcId).toBe(vpcId);
            },
        );
    });

    // =========================================================================
    // Security Group — Cluster Base (18 inbound rules)
    //
    // Self-referencing: etcd, API, kubelet, controller-manager, scheduler,
    //   VXLAN, BGP, NodePort, CoreDNS (TCP+UDP), Typha, metrics (×2)
    // Pod CIDR: API, kubelet, CoreDNS (TCP+UDP), metrics (×2)
    // =========================================================================
    describe('Cluster Base SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];
        let sgId: string;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            sgId = requireParam(ssmParams, SSM_PATHS.securityGroupId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        // --- Self-referencing TCP rules ---
        it.each([
            { port: 2379, endPort: 2380, desc: 'etcd client+peer' },
            { port: 6443, desc: 'K8s API server' },
            { port: 10250, desc: 'kubelet API' },
            { port: 10257, desc: 'kube-controller-manager' },
            { port: 10259, desc: 'kube-scheduler' },
            { port: 179, desc: 'Calico BGP' },
            { port: 30000, endPort: 32767, desc: 'NodePort range' },
            { port: 53, desc: 'CoreDNS TCP' },
            { port: 5473, desc: 'Calico Typha' },
            { port: 9100, desc: 'Traefik metrics' },
            { port: 9101, desc: 'Node Exporter metrics' },
        ])(
            'should have self-referencing TCP rule for $desc (port $port)',
            ({ port, endPort }) => {
                const rule = findTcpIngressRule(ingress, port, endPort);
                expect(rule).toBeDefined();
                expectSelfReferencing(rule!, sgId);
            },
        );

        // --- Self-referencing UDP rules ---
        it('should have self-referencing UDP rule for VXLAN (port 4789)', () => {
            const rule = findUdpIngressRule(ingress, 4789);
            expect(rule).toBeDefined();
            expectSelfReferencing(rule!, sgId);
        });

        it('should have self-referencing UDP rule for CoreDNS (port 53)', () => {
            const rule = findUdpIngressRule(ingress, 53);
            expect(rule).toBeDefined();
            expectSelfReferencing(rule!, sgId);
        });

        // --- Pod CIDR TCP rules ---
        it.each([
            { port: 6443, desc: 'K8s API server' },
            { port: 10250, desc: 'kubelet API' },
            { port: 53, desc: 'CoreDNS TCP' },
            { port: 9100, desc: 'Traefik metrics' },
            { port: 9101, desc: 'Node Exporter metrics' },
        ])(
            'should have pod CIDR TCP rule for $desc (port $port)',
            ({ port }) => {
                const rule = findTcpIngressRule(ingress, port);
                expect(rule).toBeDefined();
                expectCidrSource(rule!, POD_CIDR_PREFIX);
            },
        );

        // --- Pod CIDR UDP rules ---
        it('should have pod CIDR UDP rule for CoreDNS (port 53)', () => {
            const rule = findUdpIngressRule(ingress, 53);
            expect(rule).toBeDefined();
            expectCidrSource(rule!, POD_CIDR_PREFIX);
        });

        it('should allow all outbound traffic', () => {
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === ANY_IPV4),
            );
            expect(allTrafficRule).toBeDefined();
        });
    });

    // =========================================================================
    // Security Group — Control Plane (port 6443 from VPC CIDR)
    // =========================================================================
    describe('Control Plane SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.controlPlaneSgId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it('should have K8s API port 6443 open from VPC CIDR', () => {
            const apiRule = findTcpIngressRule(ingress, 6443);
            expect(apiRule).toBeDefined();
            expectCidrSource(apiRule!, VPC_CIDR_PREFIX);
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === ANY_IPV4),
            );
            expect(allTrafficRule).toBeUndefined();
        });
    });

    // =========================================================================
    // Security Group — Ingress (CloudFront, admin IPs, health checks)
    //
    // Config-driven: port 80 from VPC CIDR (NLB health checks)
    // Runtime-added: port 80 from CloudFront prefix list
    // Runtime-added: port 443 from admin IPs (if resolved at synth)
    // =========================================================================
    describe('Ingress SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.ingressSgId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it('should have HTTP port 80 from VPC CIDR (NLB health checks)', () => {
            const httpRule = findTcpIngressRule(ingress, 80);
            expect(httpRule).toBeDefined();
            expectCidrSource(httpRule!, VPC_CIDR_PREFIX);
        });

        it('should have HTTP port 80 from CloudFront prefix list', () => {
            const httpRule = findTcpIngressRule(ingress, 80);
            expect(httpRule).toBeDefined();
            expectPrefixListSource(httpRule!);
        });

        it('should have HTTPS port 443 for admin access', () => {
            const httpsRule = findTcpIngressRule(ingress, 443);
            expect(httpsRule).toBeDefined();
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === ANY_IPV4),
            );
            expect(allTrafficRule).toBeUndefined();
        });
    });

    // =========================================================================
    // Security Group — Monitoring (Prometheus, Node Exporter, Loki, Tempo)
    // =========================================================================
    describe('Monitoring SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.monitoringSgId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it.each([
            { port: 9090, desc: 'Prometheus metrics' },
            { port: 9100, desc: 'Node Exporter metrics (VPC)' },
            { port: 30100, desc: 'Loki push API' },
            { port: 30417, desc: 'Tempo OTLP gRPC' },
        ])(
            'should have TCP rule for $desc (port $port) from VPC CIDR',
            ({ port }) => {
                const rule = findTcpIngressRule(ingress, port);
                expect(rule).toBeDefined();
                expectCidrSource(rule!, VPC_CIDR_PREFIX);
            },
        );

        it('should have Node Exporter port 9100 from pod CIDR (Prometheus scraping)', () => {
            const rule = findTcpIngressRule(ingress, 9100);
            expect(rule).toBeDefined();
            expectCidrSource(rule!, POD_CIDR_PREFIX);
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === ANY_IPV4),
            );
            expect(allTrafficRule).toBeUndefined();
        });
    });

    // =========================================================================
    // Security Group — NLB (discovered via NLB API, not SSM)
    //
    // Inbound: 0.0.0.0/0 on ports 80 and 443
    // Outbound: VPC CIDR on ports 80 and 443
    // Depends on: nlbSgIngress, nlbSgEgress populated in top-level beforeAll
    // =========================================================================
    describe('NLB SG — Rule Validation', () => {
        it('should have inbound TCP 80 from 0.0.0.0/0', () => {
            const httpRule = findTcpIngressRule(nlbSgIngress, 80);
            expect(httpRule).toBeDefined();
            expectCidrSource(httpRule!, ANY_IPV4);
        });

        it('should have inbound TCP 443 from 0.0.0.0/0', () => {
            const httpsRule = findTcpIngressRule(nlbSgIngress, 443);
            expect(httpsRule).toBeDefined();
            expectCidrSource(httpsRule!, ANY_IPV4);
        });

        it('should have outbound TCP 80 to VPC CIDR', () => {
            const http = nlbSgEgress.find(
                (r) => r.FromPort === 80 && r.ToPort === 80 && r.IpProtocol === 'tcp',
            );
            expect(http).toBeDefined();
            expectCidrSource(http!, VPC_CIDR_PREFIX);
        });

        it('should have outbound TCP 443 to VPC CIDR', () => {
            const https = nlbSgEgress.find(
                (r) => r.FromPort === 443 && r.ToPort === 443 && r.IpProtocol === 'tcp',
            );
            expect(https).toBeDefined();
            expectCidrSource(https!, VPC_CIDR_PREFIX);
        });

        it('should NOT have unrestricted outbound (0.0.0.0/0 all protocols)', () => {
            const allTrafficRule = nlbSgEgress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === ANY_IPV4),
            );
            expect(allTrafficRule).toBeUndefined();
        });
    });

    // =========================================================================
    // Network Load Balancer — Configuration
    // Depends on: nlb, nlbAttributes populated in top-level beforeAll
    // =========================================================================
    describe('NLB — Configuration', () => {
        it('should be internet-facing', () => {
            expect(nlb.Scheme).toBe('internet-facing');
        });

        it('should be of type network', () => {
            expect(nlb.Type).toBe('network');
        });

        it('should have EIP attached (public IP matches SSM)', () => {
            const expectedIp = requireParam(ssmParams, SSM_PATHS.elasticIp);

            const azInfo = nlb.AvailabilityZones ?? [];
            const addresses = azInfo.flatMap((az) =>
                (az.LoadBalancerAddresses ?? []).map((a) => a.IpAddress),
            );
            expect(addresses).toContain(expectedIp);
        });

        it('should have access logging enabled', () => {
            const accessLogs = nlbAttributes.find(
                (a) => a.Key === 'access_logs.s3.enabled',
            );
            expect(accessLogs?.Value).toBe('true');
        });

        it('should have access logs S3 prefix set', () => {
            const prefix = nlbAttributes.find(
                (a) => a.Key === 'access_logs.s3.prefix',
            );
            expect(prefix?.Value).toBe(NLB_LOG_PREFIX);
        });
    });

    // =========================================================================
    // NLB Target Groups (HTTP + HTTPS)
    // Depends on: httpTargetGroup, httpsTargetGroup populated in top-level beforeAll
    // =========================================================================
    describe('NLB — Target Groups', () => {
        it('should have an HTTP target group on port 80', () => {
            expect(httpTargetGroup.Port).toBe(80);
            expect(httpTargetGroup.Protocol).toBe('TCP');
        });

        it('should have an HTTPS target group on port 443', () => {
            expect(httpsTargetGroup.Port).toBe(443);
            expect(httpsTargetGroup.Protocol).toBe('TCP');
        });

        it('should health-check HTTPS target group on port 80', () => {
            // Health check port is 80 (Traefik always listening), not 443
            expect(httpsTargetGroup.HealthCheckPort).toBe('80');
        });
    });

    // =========================================================================
    // NLB Listeners
    // Depends on: nlbListeners populated in top-level beforeAll
    // =========================================================================
    describe('NLB — Listeners', () => {
        it('should have the expected number of listeners (HTTP + HTTPS)', () => {
            expect(nlbListeners).toHaveLength(EXPECTED_LISTENER_COUNT);
        });

        it('should have a TCP listener on port 80', () => {
            const httpListener = nlbListeners.find((l) => l.Port === 80);
            expect(httpListener).toBeDefined();
            expect(httpListener!.Protocol).toBe('TCP');
        });

        it('should have a TCP listener on port 443', () => {
            const httpsListener = nlbListeners.find((l) => l.Port === 443);
            expect(httpsListener).toBeDefined();
            expect(httpsListener!.Protocol).toBe('TCP');
        });
    });

    // =========================================================================
    // EBS Volume
    // =========================================================================
    describe('EBS Volume', () => {
        let volumeId: string;
        let volume: {
            Encrypted?: boolean;
            VolumeType?: string;
            Size?: number;
            AvailabilityZone?: string;
        };

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            volumeId = requireParam(ssmParams, SSM_PATHS.ebsVolumeId);

            const { Volumes } = await ec2.send(
                new DescribeVolumesCommand({ VolumeIds: [volumeId] }),
            );
            expect(Volumes).toHaveLength(1);
            volume = Volumes![0];
        });

        it('should be encrypted', () => {
            expect(volume.Encrypted).toBe(true);
        });

        it('should use GP3 volume type', () => {
            expect(volume.VolumeType).toBe('gp3');
        });

        it('should be the configured size', () => {
            expect(volume.Size).toBe(CONFIGS.storage.volumeSizeGb);
        });

        it('should be in the correct availability zone', () => {
            expect(volume.AvailabilityZone).toBe(`${REGION}a`);
        });
    });

    // =========================================================================
    // Elastic IP
    // =========================================================================
    describe('Elastic IP', () => {
        let eipAddress: {
            Domain?: string;
            PublicIp?: string;
        };

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const allocationId = requireParam(ssmParams, SSM_PATHS.elasticIpAllocationId);

            const { Addresses } = await ec2.send(
                new DescribeAddressesCommand({
                    AllocationIds: [allocationId],
                }),
            );
            expect(Addresses).toHaveLength(1);
            eipAddress = Addresses![0];
        });

        it('should exist as a VPC allocation', () => {
            expect(eipAddress.Domain).toBe('vpc');
        });

        it('should have a public IP matching the SSM parameter', () => {
            const expectedIp = requireParam(ssmParams, SSM_PATHS.elasticIp);
            expect(eipAddress.PublicIp).toBe(expectedIp);
        });
    });

    // =========================================================================
    // KMS Key
    // =========================================================================
    describe('KMS Key', () => {
        let keyMetadata: KeyMetadata;
        let keyRotationEnabled: boolean;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const keyArn = requireParam(ssmParams, SSM_PATHS.kmsKeyArn);

            const [descResp, rotResp] = await Promise.all([
                kms.send(new DescribeKeyCommand({ KeyId: keyArn })),
                kms.send(new GetKeyRotationStatusCommand({ KeyId: keyArn })),
            ]);

            expect(descResp.KeyMetadata).toBeDefined();
            keyMetadata = descResp.KeyMetadata!;
            keyRotationEnabled = rotResp.KeyRotationEnabled ?? false;
        });

        it('should be enabled', () => {
            expect(keyMetadata.Enabled).toBe(true);
            expect(keyMetadata.KeyState).toBe('Enabled');
        });

        it('should have key rotation enabled', () => {
            expect(keyRotationEnabled).toBe(true);
        });
    });

    // =========================================================================
    // S3 Buckets — Scripts
    // =========================================================================
    describe('S3 Scripts Bucket', () => {
        let bucketName: string;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(() => {
            bucketName = requireParam(ssmParams, SSM_PATHS.scriptsBucket);
        });

        it('should exist and be accessible', async () => {
            await expect(
                s3.send(new HeadBucketCommand({ Bucket: bucketName })),
            ).resolves.toBeDefined();
        });

        it('should have server-side encryption enabled', async () => {
            const { ServerSideEncryptionConfiguration } = await s3.send(
                new GetBucketEncryptionCommand({ Bucket: bucketName }),
            );

            expect(ServerSideEncryptionConfiguration?.Rules).toBeDefined();
            expect(ServerSideEncryptionConfiguration!.Rules!.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // S3 Buckets — NLB Access Logs
    // Depends on: nlbLogBucketName populated in top-level beforeAll
    // =========================================================================
    describe('S3 NLB Access Logs Bucket', () => {
        it('should exist and be accessible', async () => {
            await expect(
                s3.send(new HeadBucketCommand({ Bucket: nlbLogBucketName })),
            ).resolves.toBeDefined();
        });

        it('should have the correct bucket name prefix', () => {
            expect(nlbLogBucketName).toContain(`${NAME_PREFIX}-nlb-access-logs`);
        });

        it('should have SSE-S3 encryption enabled', async () => {
            const { ServerSideEncryptionConfiguration } = await s3.send(
                new GetBucketEncryptionCommand({ Bucket: nlbLogBucketName }),
            );

            expect(ServerSideEncryptionConfiguration?.Rules).toBeDefined();
            expect(ServerSideEncryptionConfiguration!.Rules!.length).toBeGreaterThan(0);

            const sseRule = ServerSideEncryptionConfiguration!.Rules![0];
            expect(
                sseRule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
            ).toBe('AES256');
        });

        it('should have a 3-day lifecycle expiration policy', async () => {
            const { Rules } = await s3.send(
                new GetBucketLifecycleConfigurationCommand({ Bucket: nlbLogBucketName }),
            );

            expect(Rules).toBeDefined();
            expect(Rules!.length).toBeGreaterThanOrEqual(1);

            const expirationRule = Rules!.find(
                (r) => r.Expiration?.Days !== undefined,
            );
            expect(expirationRule).toBeDefined();
            expect(expirationRule!.Expiration!.Days).toBe(NLB_LOG_LIFECYCLE_DAYS);
            expect(expirationRule!.Status).toBe('Enabled');
        });
    });

    // =========================================================================
    // Route 53 Private Hosted Zone
    // =========================================================================
    describe('Route 53', () => {
        let hostedZone: HostedZone;
        let aRecord: ResourceRecordSet | undefined;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const hostedZoneId = requireParam(ssmParams, SSM_PATHS.hostedZoneId);

            const [zoneResp, recordResp] = await Promise.all([
                route53.send(new GetHostedZoneCommand({ Id: hostedZoneId })),
                route53.send(new ListResourceRecordSetsCommand({
                    HostedZoneId: hostedZoneId,
                    StartRecordName: K8S_API_FQDN,
                    StartRecordType: 'A',
                    MaxItems: 1,
                })),
            ]);

            expect(zoneResp.HostedZone).toBeDefined();
            hostedZone = zoneResp.HostedZone!;

            aRecord = recordResp.ResourceRecordSets?.find(
                (r) => r.Name === K8S_API_FQDN_DOT && r.Type === 'A',
            );
        });

        it('should have a private hosted zone for k8s.internal', () => {
            expect(hostedZone.Name).toBe(K8S_INTERNAL_ZONE);
            expect(hostedZone.Config?.PrivateZone).toBe(true);
        });

        it('should have an A record for k8s-api.k8s.internal', () => {
            expect(aRecord).toBeDefined();
            expect(aRecord!.TTL).toBe(API_RECORD_TTL);
        });
    });
});
