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
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';
import {
    EC2Client,
    DescribeVpcsCommand,
    DescribeSecurityGroupsCommand,
    DescribeVolumesCommand,
    DescribeAddressesCommand,
    DescribeFlowLogsCommand,
} from '@aws-sdk/client-ec2';
import {
    KMSClient,
    DescribeKeyCommand,
    GetKeyRotationStatusCommand,
} from '@aws-sdk/client-kms';
import {
    S3Client,
    HeadBucketCommand,
    GetBucketEncryptionCommand,
    GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import {
    Route53Client,
    GetHostedZoneCommand,
    ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import {
    ElasticLoadBalancingV2Client,
    DescribeLoadBalancersCommand,
    DescribeTargetGroupsCommand,
    DescribeListenersCommand,
    DescribeLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

import type { IpPermission } from '@aws-sdk/client-ec2';

import { Environment } from '../../../lib/config';
import { getK8sConfigs } from '../../../lib/config/kubernetes';
import { k8sSsmPaths, k8sSsmPrefix } from '../../../lib/config/ssm-paths';

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const CONFIGS = getK8sConfigs(CDK_ENV);
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);
const NAME_PREFIX = `k8s-${CDK_ENV}`;

// AWS SDK clients (shared across tests)
const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const kms = new KMSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const route53 = new Route53Client({ region: REGION });
const elbv2 = new ElasticLoadBalancingV2Client({ region: REGION });
const cwl = new CloudWatchLogsClient({ region: REGION });

// =============================================================================
// SSM Parameter Cache
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
// Helper: SG Rule Assertion Utilities
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
// Tests
// =============================================================================

describe('KubernetesBaseStack — Post-Deploy Verification', () => {
    let ssmParams: Map<string, string>;

    // Load SSM parameters ONCE before all tests
    beforeAll(async () => {
        ssmParams = await loadSsmParameters();
    });

    // =========================================================================
    // SSM Parameters (14)
    // =========================================================================
    describe('SSM Parameters', () => {
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
        ] as const;

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

        it('should store k8s-api.k8s.internal as the API DNS name', () => {
            expect(ssmParams.get(SSM_PATHS.apiDnsName)).toBe(
                'k8s-api.k8s.internal',
            );
        });

        it('NLB target group ARNs should be valid ARN format', () => {
            const httpArn = ssmParams.get(SSM_PATHS.nlbHttpTargetGroupArn)!;
            const httpsArn = ssmParams.get(SSM_PATHS.nlbHttpsTargetGroupArn)!;

            expect(httpArn).toMatch(/^arn:aws:elasticloadbalancing:/);
            expect(httpsArn).toMatch(/^arn:aws:elasticloadbalancing:/);
        });
    });

    // =========================================================================
    // VPC
    // =========================================================================
    describe('VPC', () => {
        it('should exist and be in available state', async () => {
            const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;

            const { Vpcs } = await ec2.send(
                new DescribeVpcsCommand({ VpcIds: [vpcId] }),
            );

            expect(Vpcs).toHaveLength(1);
            expect(Vpcs![0].State).toBe('available');
        });
    });

    // =========================================================================
    // VPC Flow Logs
    // =========================================================================
    describe('VPC Flow Logs', () => {
        it('should have flow logs enabled for the VPC', async () => {
            const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;

            const { FlowLogs } = await ec2.send(
                new DescribeFlowLogsCommand({
                    Filter: [{
                        Name: 'resource-id',
                        Values: [vpcId],
                    }],
                }),
            );

            expect(FlowLogs).toBeDefined();
            expect(FlowLogs!.length).toBeGreaterThan(0);
        });

        it('flow logs should deliver to CloudWatch Logs', async () => {
            const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;

            const { FlowLogs } = await ec2.send(
                new DescribeFlowLogsCommand({
                    Filter: [{
                        Name: 'resource-id',
                        Values: [vpcId],
                    }],
                }),
            );

            const cwlFlow = FlowLogs?.find(
                (f) => f.LogDestinationType === 'cloud-watch-logs',
            );
            expect(cwlFlow).toBeDefined();
            expect(cwlFlow!.FlowLogStatus).toBe('ACTIVE');
        });

        it('CloudWatch log group should have 3-day retention', async () => {
            const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;

            const { FlowLogs } = await ec2.send(
                new DescribeFlowLogsCommand({
                    Filter: [{
                        Name: 'resource-id',
                        Values: [vpcId],
                    }],
                }),
            );

            const cwlFlow = FlowLogs?.find(
                (f) => f.LogDestinationType === 'cloud-watch-logs',
            );
            const logGroupName = cwlFlow?.LogGroupName;
            expect(logGroupName).toBeDefined();

            const { logGroups } = await cwl.send(
                new DescribeLogGroupsCommand({
                    logGroupNamePrefix: logGroupName!,
                }),
            );

            const logGroup = logGroups?.find((g) => g.logGroupName === logGroupName);
            expect(logGroup).toBeDefined();
            expect(logGroup!.retentionInDays).toBe(3);
        });
    });

    // =========================================================================
    // Security Groups — Existence & VPC Attachment (×5)
    // =========================================================================
    describe('Security Groups — Existence', () => {
        const sgKeys = [
            { key: 'securityGroupId', label: 'Cluster Base' },
            { key: 'controlPlaneSgId', label: 'Control Plane' },
            { key: 'ingressSgId', label: 'Ingress' },
            { key: 'monitoringSgId', label: 'Monitoring' },
        ] as const;

        it.each(sgKeys)(
            '$label SG should exist and be attached to the VPC',
            async ({ key }) => {
                const sgId = ssmParams.get(SSM_PATHS[key])!;
                const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;

                const { SecurityGroups } = await ec2.send(
                    new DescribeSecurityGroupsCommand({
                        GroupIds: [sgId],
                    }),
                );

                expect(SecurityGroups).toHaveLength(1);
                expect(SecurityGroups![0].VpcId).toBe(vpcId);
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
        let sgId: string;

        beforeAll(async () => {
            sgId = ssmParams.get(SSM_PATHS.securityGroupId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            ingress = SecurityGroups![0].IpPermissions ?? [];
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
                // Pod CIDR is 192.168.0.0/16
                expectCidrSource(rule!, '192.168.');
            },
        );

        // --- Pod CIDR UDP rules ---
        it('should have pod CIDR UDP rule for CoreDNS (port 53)', () => {
            const rule = findUdpIngressRule(ingress, 53);
            expect(rule).toBeDefined();
            expectCidrSource(rule!, '192.168.');
        });

        it('should allow all outbound traffic', async () => {
            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            const egress = SecurityGroups![0].IpPermissionsEgress ?? [];

            // allowAllOutbound: true creates a 0.0.0.0/0 all-protocols egress rule
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === '0.0.0.0/0'),
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

        beforeAll(async () => {
            const sgId = ssmParams.get(SSM_PATHS.controlPlaneSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it('should have K8s API port 6443 open from VPC CIDR', () => {
            const apiRule = findTcpIngressRule(ingress, 6443);
            expect(apiRule).toBeDefined();
            // VPC CIDR starts with 10.
            expectCidrSource(apiRule!, '10.');
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            // allowAllOutbound: false → CDK creates a "disallow all" placeholder egress
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === '0.0.0.0/0'),
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

        beforeAll(async () => {
            const sgId = ssmParams.get(SSM_PATHS.ingressSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it('should have HTTP port 80 from VPC CIDR (NLB health checks)', () => {
            const httpRule = findTcpIngressRule(ingress, 80);
            expect(httpRule).toBeDefined();
            expectCidrSource(httpRule!, '10.');
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
                    && r.IpRanges?.some((ip) => ip.CidrIp === '0.0.0.0/0'),
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

        beforeAll(async () => {
            const sgId = ssmParams.get(SSM_PATHS.monitoringSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it.each([
            { port: 9090, desc: 'Prometheus metrics', source: '10.' },
            { port: 9100, desc: 'Node Exporter metrics (VPC)', source: '10.' },
            { port: 30100, desc: 'Loki push API', source: '10.' },
            { port: 30417, desc: 'Tempo OTLP gRPC', source: '10.' },
        ])(
            'should have TCP rule for $desc (port $port) from VPC CIDR',
            ({ port, source }) => {
                const rule = findTcpIngressRule(ingress, port);
                expect(rule).toBeDefined();
                expectCidrSource(rule!, source);
            },
        );

        it('should have Node Exporter port 9100 from pod CIDR (Prometheus scraping)', () => {
            const rule = findTcpIngressRule(ingress, 9100);
            expect(rule).toBeDefined();
            expectCidrSource(rule!, '192.168.');
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === '0.0.0.0/0'),
            );
            expect(allTrafficRule).toBeUndefined();
        });
    });

    // =========================================================================
    // Security Group — NLB (discovered via NLB API, not SSM)
    //
    // Inbound: 0.0.0.0/0 on ports 80 and 443
    // Outbound: VPC CIDR on ports 80 and 443
    // =========================================================================
    describe('NLB SG — Rule Validation', () => {
        let nlbSgId: string;
        let ingress: IpPermission[];
        let egress: IpPermission[];

        beforeAll(async () => {
            // Discover NLB by name, then get its SGs
            const { LoadBalancers } = await elbv2.send(
                new DescribeLoadBalancersCommand({
                    Names: [`${NAME_PREFIX}-nlb`],
                }),
            );
            expect(LoadBalancers).toHaveLength(1);

            const sgIds = LoadBalancers![0].SecurityGroups ?? [];
            expect(sgIds.length).toBeGreaterThan(0);
            nlbSgId = sgIds[0];

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [nlbSgId] }),
            );
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it('should have inbound TCP 80 from 0.0.0.0/0', () => {
            const httpRule = findTcpIngressRule(ingress, 80);
            expect(httpRule).toBeDefined();
            expectCidrSource(httpRule!, '0.0.0.0/0');
        });

        it('should have inbound TCP 443 from 0.0.0.0/0', () => {
            const httpsRule = findTcpIngressRule(ingress, 443);
            expect(httpsRule).toBeDefined();
            expectCidrSource(httpsRule!, '0.0.0.0/0');
        });

        it('should have outbound TCP 80 to VPC CIDR', () => {
            const http = egress.find(
                (r) => r.FromPort === 80 && r.ToPort === 80 && r.IpProtocol === 'tcp',
            );
            expect(http).toBeDefined();
            expectCidrSource(http!, '10.');
        });

        it('should have outbound TCP 443 to VPC CIDR', () => {
            const https = egress.find(
                (r) => r.FromPort === 443 && r.ToPort === 443 && r.IpProtocol === 'tcp',
            );
            expect(https).toBeDefined();
            expectCidrSource(https!, '10.');
        });

        it('should NOT have unrestricted outbound (0.0.0.0/0 all protocols)', () => {
            const allTrafficRule = egress.find(
                (r) => r.IpProtocol === '-1'
                    && r.IpRanges?.some((ip) => ip.CidrIp === '0.0.0.0/0'),
            );
            expect(allTrafficRule).toBeUndefined();
        });
    });

    // =========================================================================
    // Network Load Balancer — Configuration
    // =========================================================================
    describe('NLB — Configuration', () => {
        let nlbArn: string;

        beforeAll(async () => {
            const { LoadBalancers } = await elbv2.send(
                new DescribeLoadBalancersCommand({
                    Names: [`${NAME_PREFIX}-nlb`],
                }),
            );
            expect(LoadBalancers).toHaveLength(1);
            nlbArn = LoadBalancers![0].LoadBalancerArn!;
        });

        it('should be internet-facing', async () => {
            const { LoadBalancers } = await elbv2.send(
                new DescribeLoadBalancersCommand({
                    Names: [`${NAME_PREFIX}-nlb`],
                }),
            );
            expect(LoadBalancers![0].Scheme).toBe('internet-facing');
        });

        it('should be of type network', async () => {
            const { LoadBalancers } = await elbv2.send(
                new DescribeLoadBalancersCommand({
                    Names: [`${NAME_PREFIX}-nlb`],
                }),
            );
            expect(LoadBalancers![0].Type).toBe('network');
        });

        it('should have EIP attached (public IP matches SSM)', async () => {
            const expectedIp = ssmParams.get(SSM_PATHS.elasticIp)!;

            const { LoadBalancers } = await elbv2.send(
                new DescribeLoadBalancersCommand({
                    Names: [`${NAME_PREFIX}-nlb`],
                }),
            );

            // NLB with EIP — the static IP appears in the AZ info
            const azInfo = LoadBalancers![0].AvailabilityZones ?? [];
            const addresses = azInfo.flatMap((az) =>
                (az.LoadBalancerAddresses ?? []).map((a) => a.IpAddress),
            );
            expect(addresses).toContain(expectedIp);
        });

        it('should have access logging enabled', async () => {
            const { Attributes } = await elbv2.send(
                new DescribeLoadBalancerAttributesCommand({
                    LoadBalancerArn: nlbArn,
                }),
            );

            const accessLogs = Attributes?.find(
                (a) => a.Key === 'access_logs.s3.enabled',
            );
            expect(accessLogs?.Value).toBe('true');
        });

        it('should have access logs S3 prefix set', async () => {
            const { Attributes } = await elbv2.send(
                new DescribeLoadBalancerAttributesCommand({
                    LoadBalancerArn: nlbArn,
                }),
            );

            const prefix = Attributes?.find(
                (a) => a.Key === 'access_logs.s3.prefix',
            );
            expect(prefix?.Value).toBe('nlb-access-logs');
        });
    });

    // =========================================================================
    // NLB Target Groups (HTTP + HTTPS)
    // =========================================================================
    describe('NLB — Target Groups', () => {
        it('should have an HTTP target group on port 80', async () => {
            const arn = ssmParams.get(SSM_PATHS.nlbHttpTargetGroupArn)!;

            const { TargetGroups } = await elbv2.send(
                new DescribeTargetGroupsCommand({
                    TargetGroupArns: [arn],
                }),
            );

            expect(TargetGroups).toHaveLength(1);
            expect(TargetGroups![0].Port).toBe(80);
            expect(TargetGroups![0].Protocol).toBe('TCP');
        });

        it('should have an HTTPS target group on port 443', async () => {
            const arn = ssmParams.get(SSM_PATHS.nlbHttpsTargetGroupArn)!;

            const { TargetGroups } = await elbv2.send(
                new DescribeTargetGroupsCommand({
                    TargetGroupArns: [arn],
                }),
            );

            expect(TargetGroups).toHaveLength(1);
            expect(TargetGroups![0].Port).toBe(443);
            expect(TargetGroups![0].Protocol).toBe('TCP');
        });

        it('HTTPS target group should health-check on port 80', async () => {
            const arn = ssmParams.get(SSM_PATHS.nlbHttpsTargetGroupArn)!;

            const { TargetGroups } = await elbv2.send(
                new DescribeTargetGroupsCommand({
                    TargetGroupArns: [arn],
                }),
            );

            // Health check port is 80 (Traefik always listening), not 443
            expect(TargetGroups![0].HealthCheckPort).toBe('80');
        });
    });

    // =========================================================================
    // NLB Listeners
    // =========================================================================
    describe('NLB — Listeners', () => {
        let nlbArn: string;

        beforeAll(async () => {
            const { LoadBalancers } = await elbv2.send(
                new DescribeLoadBalancersCommand({
                    Names: [`${NAME_PREFIX}-nlb`],
                }),
            );
            nlbArn = LoadBalancers![0].LoadBalancerArn!;
        });

        it('should have 2 listeners (HTTP + HTTPS)', async () => {
            const { Listeners } = await elbv2.send(
                new DescribeListenersCommand({
                    LoadBalancerArn: nlbArn,
                }),
            );

            expect(Listeners).toHaveLength(2);
        });

        it('should have a TCP listener on port 80', async () => {
            const { Listeners } = await elbv2.send(
                new DescribeListenersCommand({
                    LoadBalancerArn: nlbArn,
                }),
            );

            const httpListener = Listeners?.find((l) => l.Port === 80);
            expect(httpListener).toBeDefined();
            expect(httpListener!.Protocol).toBe('TCP');
        });

        it('should have a TCP listener on port 443', async () => {
            const { Listeners } = await elbv2.send(
                new DescribeListenersCommand({
                    LoadBalancerArn: nlbArn,
                }),
            );

            const httpsListener = Listeners?.find((l) => l.Port === 443);
            expect(httpsListener).toBeDefined();
            expect(httpsListener!.Protocol).toBe('TCP');
        });
    });

    // =========================================================================
    // EBS Volume
    // =========================================================================
    describe('EBS Volume', () => {
        it('should exist, be encrypted, and use GP3', async () => {
            const volumeId = ssmParams.get(SSM_PATHS.ebsVolumeId)!;

            const { Volumes } = await ec2.send(
                new DescribeVolumesCommand({ VolumeIds: [volumeId] }),
            );

            expect(Volumes).toHaveLength(1);
            const vol = Volumes![0];
            expect(vol.Encrypted).toBe(true);
            expect(vol.VolumeType).toBe('gp3');
            expect(vol.Size).toBe(CONFIGS.storage.volumeSizeGb);
        });

        it('should be in the correct availability zone', async () => {
            const volumeId = ssmParams.get(SSM_PATHS.ebsVolumeId)!;

            const { Volumes } = await ec2.send(
                new DescribeVolumesCommand({ VolumeIds: [volumeId] }),
            );

            expect(Volumes![0].AvailabilityZone).toBe(`${REGION}a`);
        });
    });

    // =========================================================================
    // Elastic IP
    // =========================================================================
    describe('Elastic IP', () => {
        it('should exist as a VPC allocation', async () => {
            const allocationId = ssmParams.get(SSM_PATHS.elasticIpAllocationId)!;

            const { Addresses } = await ec2.send(
                new DescribeAddressesCommand({
                    AllocationIds: [allocationId],
                }),
            );

            expect(Addresses).toHaveLength(1);
            expect(Addresses![0].Domain).toBe('vpc');
        });

        it('should have a public IP matching the SSM parameter', async () => {
            const allocationId = ssmParams.get(SSM_PATHS.elasticIpAllocationId)!;
            const expectedIp = ssmParams.get(SSM_PATHS.elasticIp)!;

            const { Addresses } = await ec2.send(
                new DescribeAddressesCommand({
                    AllocationIds: [allocationId],
                }),
            );

            expect(Addresses![0].PublicIp).toBe(expectedIp);
        });
    });

    // =========================================================================
    // KMS Key
    // =========================================================================
    describe('KMS Key', () => {
        it('should exist and be enabled', async () => {
            const keyArn = ssmParams.get(SSM_PATHS.kmsKeyArn)!;

            const { KeyMetadata } = await kms.send(
                new DescribeKeyCommand({ KeyId: keyArn }),
            );

            expect(KeyMetadata).toBeDefined();
            expect(KeyMetadata!.Enabled).toBe(true);
            expect(KeyMetadata!.KeyState).toBe('Enabled');
        });

        it('should have key rotation enabled', async () => {
            const keyArn = ssmParams.get(SSM_PATHS.kmsKeyArn)!;

            const { KeyRotationEnabled } = await kms.send(
                new GetKeyRotationStatusCommand({ KeyId: keyArn }),
            );

            expect(KeyRotationEnabled).toBe(true);
        });
    });

    // =========================================================================
    // S3 Buckets — Scripts
    // =========================================================================
    describe('S3 Scripts Bucket', () => {
        it('should exist and be accessible', async () => {
            const bucketName = ssmParams.get(SSM_PATHS.scriptsBucket)!;

            await expect(
                s3.send(new HeadBucketCommand({ Bucket: bucketName })),
            ).resolves.toBeDefined();
        });

        it('should have server-side encryption enabled', async () => {
            const bucketName = ssmParams.get(SSM_PATHS.scriptsBucket)!;

            const { ServerSideEncryptionConfiguration } = await s3.send(
                new GetBucketEncryptionCommand({ Bucket: bucketName }),
            );

            expect(ServerSideEncryptionConfiguration?.Rules).toBeDefined();
            expect(ServerSideEncryptionConfiguration!.Rules!.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // S3 Buckets — NLB Access Logs
    // =========================================================================
    describe('S3 NLB Access Logs Bucket', () => {
        const nlbBucketName = `${NAME_PREFIX}-nlb-access-logs`;

        /**
         * Find the NLB access log bucket by name prefix.
         * The full name includes account ID and region.
         */
        async function findNlbLogBucket(): Promise<string> {
            const { Attributes } = await elbv2.send(
                new DescribeLoadBalancerAttributesCommand({
                    LoadBalancerArn: await getNlbArn(),
                }),
            );
            const bucket = Attributes?.find(
                (a) => a.Key === 'access_logs.s3.bucket',
            );
            expect(bucket?.Value).toBeDefined();
            return bucket!.Value!;
        }

        async function getNlbArn(): Promise<string> {
            const { LoadBalancers } = await elbv2.send(
                new DescribeLoadBalancersCommand({
                    Names: [`${NAME_PREFIX}-nlb`],
                }),
            );
            return LoadBalancers![0].LoadBalancerArn!;
        }

        it('should exist and be accessible', async () => {
            const bucketName = await findNlbLogBucket();

            await expect(
                s3.send(new HeadBucketCommand({ Bucket: bucketName })),
            ).resolves.toBeDefined();
        });

        it('should have the correct bucket name prefix', async () => {
            const bucketName = await findNlbLogBucket();
            expect(bucketName).toContain(nlbBucketName);
        });

        it('should have server-side encryption enabled', async () => {
            const bucketName = await findNlbLogBucket();

            const { ServerSideEncryptionConfiguration } = await s3.send(
                new GetBucketEncryptionCommand({ Bucket: bucketName }),
            );

            expect(ServerSideEncryptionConfiguration?.Rules).toBeDefined();
            expect(ServerSideEncryptionConfiguration!.Rules!.length).toBeGreaterThan(0);

            const sseRule = ServerSideEncryptionConfiguration!.Rules![0];
            expect(
                sseRule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
            ).toBe('AES256');
        });

        it('should have a 3-day lifecycle expiration policy', async () => {
            const bucketName = await findNlbLogBucket();

            const { Rules } = await s3.send(
                new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }),
            );

            expect(Rules).toBeDefined();
            expect(Rules!.length).toBeGreaterThanOrEqual(1);

            const expirationRule = Rules!.find(
                (r) => r.Expiration?.Days !== undefined,
            );
            expect(expirationRule).toBeDefined();
            expect(expirationRule!.Expiration!.Days).toBe(3);
            expect(expirationRule!.Status).toBe('Enabled');
        });
    });

    // =========================================================================
    // Route 53 Private Hosted Zone
    // =========================================================================
    describe('Route 53', () => {
        it('should have a private hosted zone for k8s.internal', async () => {
            const hostedZoneId = ssmParams.get(SSM_PATHS.hostedZoneId)!;

            const { HostedZone } = await route53.send(
                new GetHostedZoneCommand({
                    Id: hostedZoneId,
                }),
            );

            expect(HostedZone?.Name).toBe('k8s.internal.');
            expect(HostedZone?.Config?.PrivateZone).toBe(true);
        });

        it('should have an A record for k8s-api.k8s.internal', async () => {
            const hostedZoneId = ssmParams.get(SSM_PATHS.hostedZoneId)!;

            const { ResourceRecordSets } = await route53.send(
                new ListResourceRecordSetsCommand({
                    HostedZoneId: hostedZoneId,
                    StartRecordName: 'k8s-api.k8s.internal',
                    StartRecordType: 'A',
                    MaxItems: 1,
                }),
            );

            const aRecord = ResourceRecordSets?.find(
                (r) => r.Name === 'k8s-api.k8s.internal.' && r.Type === 'A',
            );

            expect(aRecord).toBeDefined();
            expect(aRecord!.TTL).toBe(30);
        });
    });

    // =========================================================================
    // Readiness Gate
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('all resources required by downstream stacks should be discoverable via SSM', () => {
            // Compute stack needs: VPC, SGs, EBS, KMS, Scripts Bucket, Hosted Zone, NLB TGs
            const requiredKeys = [
                SSM_PATHS.vpcId,
                SSM_PATHS.securityGroupId,
                SSM_PATHS.controlPlaneSgId,
                SSM_PATHS.ingressSgId,
                SSM_PATHS.monitoringSgId,
                SSM_PATHS.ebsVolumeId,
                SSM_PATHS.kmsKeyArn,
                SSM_PATHS.scriptsBucket,
                SSM_PATHS.hostedZoneId,
                SSM_PATHS.elasticIp,
                SSM_PATHS.elasticIpAllocationId,
                SSM_PATHS.nlbHttpTargetGroupArn,
                SSM_PATHS.nlbHttpsTargetGroupArn,
            ];

            for (const path of requiredKeys) {
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.trim().length).toBeGreaterThan(0);
            }
        });
    });
});
