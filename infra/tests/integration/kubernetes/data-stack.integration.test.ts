/**
 * @format
 * Kubernetes Data Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesDataStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that all data-layer resources exist, are correctly
 * configured, and the SSM parameters are discoverable for downstream stacks
 * (Base, Edge, AppIam).
 *
 * NOTE: DynamoDB tests have been removed — the portfolio table is now
 * consolidated in AiContentStack (bedrock-{env}-ai-content).
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by the data stack
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development --testPathPattern="data-stack"
 */

import {
    CloudFormationClient,
    DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
    S3Client,
    HeadBucketCommand,
    GetBucketVersioningCommand,
    GetPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';

import { Environment } from '../../../lib/config';
import {
    nextjsResourceNames,
} from '../../../lib/config/nextjs';
import { Project, getProjectConfig } from '../../../lib/config/projects';
import {
    nextjsSsmPaths,
} from '../../../lib/config/ssm-paths';
import { stackId, STACK_REGISTRY } from '../../../lib/utilities/naming';

// =============================================================================
// Configuration — all values derived from config (same as factory.ts)
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';

// Same namePrefix the factory uses (factory.ts line 135)
const NEXTJS_NAME_PREFIX = 'nextjs';

// Config-driven values — same references the stack uses
const SSM_PATHS = nextjsSsmPaths(CDK_ENV, NEXTJS_NAME_PREFIX);
const RESOURCE_NAMES = nextjsResourceNames(NEXTJS_NAME_PREFIX, CDK_ENV);

// Stack name — derived from naming utility (same as factory)
const KUBERNETES_NAMESPACE = getProjectConfig(Project.KUBERNETES).namespace;
const DATA_STACK_NAME = stackId(KUBERNETES_NAMESPACE, STACK_REGISTRY.kubernetes.data, CDK_ENV);

// AWS SDK clients (shared across tests)
const ssm = new SSMClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

// =============================================================================
// SSM Parameter Cache
// =============================================================================

/**
 * Load all SSM parameters under the data stack's prefix in one paginated call.
 * Returns a Map<path, value> for fast lookup.
 */
async function loadSsmParameters(): Promise<Map<string, string>> {
    const params = new Map<string, string>();
    let nextToken: string | undefined;

    do {
        const response = await ssm.send(
            new GetParametersByPathCommand({
                Path: SSM_PATHS.prefix,
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
// Tests
// =============================================================================

describe('KubernetesDataStack — Post-Deploy Verification', () => {
    let ssmParams: Map<string, string>;

    // Load SSM parameters ONCE before all tests
    beforeAll(async () => {
        ssmParams = await loadSsmParameters();

        if (ssmParams.size === 0) {
            console.error(
                `[FATAL] No SSM parameters found under prefix "${SSM_PATHS.prefix}".\n` +
                `Ensure the KubernetesDataStack (${DATA_STACK_NAME}) is deployed ` +
                `and SSM parameters exist. Check IAM permissions for ssm:GetParametersByPath.`,
            );
        }
    }, 30_000);

    // =========================================================================
    // Pre-Flight — verify the test has all required parameters and variables
    // =========================================================================
    describe('Pre-Flight', () => {
        it('should have loaded SSM parameters from the correct prefix', () => {
            console.log(`[Pre-Flight] SSM prefix: ${SSM_PATHS.prefix}`);
            console.log(`[Pre-Flight] Parameters loaded: ${ssmParams.size}`);
            expect(ssmParams.size).toBeGreaterThan(0);
        });

        it('should have CDK_ENV set to a valid environment', () => {
            expect(CDK_ENV).toBeDefined();
            expect(['development', 'staging', 'production']).toContain(CDK_ENV);
        });

        it('should have AWS_REGION set', () => {
            expect(REGION).toBeDefined();
            expect(REGION.length).toBeGreaterThan(0);
        });

        it('should resolve the correct stack name from config', () => {
            console.log(`[Pre-Flight] Expected stack name: ${DATA_STACK_NAME}`);
            // Kubernetes namespace is '' → stack name is 'Data-{env}'
            expect(DATA_STACK_NAME).toMatch(/^Data-/);
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should have SSM parameter for assets bucket name', () => {
            const value = ssmParams.get(SSM_PATHS.assetsBucketName);
            expect(value).toBeDefined();
            expect(value!.length).toBeGreaterThan(0);
        });

        it('should have SSM parameter for AWS region', () => {
            const value = ssmParams.get(SSM_PATHS.awsRegion);
            expect(value).toBeDefined();
            expect(value).toBe(REGION);
        });

        it('should store the correct assets bucket name in SSM', () => {
            expect(ssmParams.get(SSM_PATHS.assetsBucketName)).toBe(
                RESOURCE_NAMES.assetsBucketName,
            );
        });
    });


    // =========================================================================
    // S3 Buckets
    // =========================================================================
    describe('S3 Assets Bucket', () => {
        it('should exist and be accessible', async () => {
            const bucketName = ssmParams.get(SSM_PATHS.assetsBucketName)!;

            await expect(
                s3.send(new HeadBucketCommand({ Bucket: bucketName })),
            ).resolves.toBeDefined();
        });

        it('should have versioning enabled', async () => {
            const bucketName = ssmParams.get(SSM_PATHS.assetsBucketName)!;

            const { Status } = await s3.send(
                new GetBucketVersioningCommand({ Bucket: bucketName }),
            );

            expect(Status).toBe('Enabled');
        });

        it('should block all public access', async () => {
            const bucketName = ssmParams.get(SSM_PATHS.assetsBucketName)!;

            const { PublicAccessBlockConfiguration } = await s3.send(
                new GetPublicAccessBlockCommand({ Bucket: bucketName }),
            );

            expect(PublicAccessBlockConfiguration?.BlockPublicAcls).toBe(true);
            expect(PublicAccessBlockConfiguration?.BlockPublicPolicy).toBe(true);
            expect(PublicAccessBlockConfiguration?.IgnorePublicAcls).toBe(true);
            expect(PublicAccessBlockConfiguration?.RestrictPublicBuckets).toBe(true);
        });

        it('should reject anonymous HTTP access (defense-in-depth)', async () => {
            const bucketName = ssmParams.get(SSM_PATHS.assetsBucketName)!;
            const url = `https://${bucketName}.s3.${REGION}.amazonaws.com/`;

            const response = await fetch(url, { method: 'GET' });
            expect(response.status).toBe(403);
        });
    });

    describe('S3 Access Logs Bucket', () => {
        it('should exist and be accessible', async () => {
            const accessLogsBucketName = `${NEXTJS_NAME_PREFIX}-access-logs-${CDK_ENV}`;

            await expect(
                s3.send(new HeadBucketCommand({ Bucket: accessLogsBucketName })),
            ).resolves.toBeDefined();
        });
    });

    // =========================================================================
    // CloudFormation Outputs
    // =========================================================================
    describe('CloudFormation Outputs', () => {
        let outputKeys: (string | undefined)[];
        let outputs: Array<{ OutputKey?: string; OutputValue?: string; ExportName?: string }>;

        // Depends on: DATA_STACK_NAME constant
        beforeAll(async () => {
            const { Stacks } = await cfn.send(
                new DescribeStacksCommand({ StackName: DATA_STACK_NAME }),
            );

            expect(Stacks).toHaveLength(1);
            outputs = Stacks![0].Outputs ?? [];
            outputKeys = outputs.map((o) => o.OutputKey);
        });

        it('should export AssetsBucketName', () => {
            expect(outputKeys).toContain('AssetsBucketName');
        });

        it('should export AssetsBucketArn', () => {
            expect(outputKeys).toContain('AssetsBucketArn');
        });

        it('should export AssetsBucketRegionalDomainName', () => {
            expect(outputKeys).toContain('AssetsBucketRegionalDomainName');
        });

        it('should export SsmParameterPrefix', () => {
            expect(outputKeys).toContain('SsmParameterPrefix');
        });

        it('should have cross-stack export names on key outputs', () => {
            const exportPrefix = `${CDK_ENV}-${NEXTJS_NAME_PREFIX}`;

            const exportNames = outputs
                .map((o) => o.ExportName)
                .filter(Boolean);

            expect(exportNames).toContain(`${exportPrefix}-assets-bucket-name`);
            expect(exportNames).toContain(`${exportPrefix}-assets-bucket-arn`);
        });
    });

    // =========================================================================
    // Downstream Readiness Gate
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('should have all SSM parameters required by downstream stacks discoverable', () => {
            // Edge stack needs: assets bucket (for CloudFront origin)
            // Both discover via SSM parameters published by this data stack
            const requiredPaths = [
                SSM_PATHS.assetsBucketName,
                SSM_PATHS.awsRegion,
            ];

            for (const path of requiredPaths) {
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.trim().length).toBeGreaterThan(0);
            }
        });
    });
});
