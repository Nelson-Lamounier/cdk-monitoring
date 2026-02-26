/**
 * @format
 * Lambda Function Construct
 *
 * Reusable Lambda function construct using CDK's NodejsFunction.
 * Handles TypeScript bundling via esbuild automatically.
 *
 * Features:
 * - Automatic TypeScript transpilation via NodejsFunction (esbuild)
 * - Source maps for debuggable CloudWatch stack traces
 * - CloudWatch log group with configurable retention
 * - IAM role with least privilege (or bring your own)
 * - VPC attachment support
 * - Environment variables with preserved NODE_OPTIONS
 * - X-Ray active tracing
 * - Dead letter queue support
 * - Bundling escape hatch via bundlingOverrides
 *
 * Log Group Strategy:
 * The log group is created BEFORE the Lambda and passed via the `logGroup` prop,
 * which tells CDK not to create a second one. This is the correct pattern for
 * controlling retention and encryption.
 *
 * MIGRATION RISK: If a Lambda already exists from a prior deployment WITHOUT an
 * explicit log group, the Lambda service will have auto-created one on first
 * invocation. Adding the explicit log group will cause CloudFormation to fail
 * with "already exists". Fix: delete the auto-created log group before deploying,
 * or import it via a custom resource.
 *
 * Bundling Format:
 * Uses CJS (CommonJS) output format by default. While Node 22 has full ESM support,
 * CJS is safer for Lambda — fewer edge cases with `require()` in dependencies,
 * no need for ESM shim banners, and no `package.json` `type: module` requirement.
 * ESM can be enabled via `bundlingOverrides: { format: OutputFormat.ESM }`.
 *
 * Naming convention:
 * The `namePrefix` prop is expected to be environment-aware, but consumers
 * typically pass explicit `functionName` values that already include the
 * environment (e.g., 'portfolio-list-articles-development'). When `functionName`
 * is not provided, the default `${namePrefix}-function` is used.
 *
 * Tag strategy:
 * Only `Component: Lambda` is applied here. Organizational tags
 * (Environment, Project, Owner, ManagedBy) come from TaggingAspect at app level.
 */

import * as fs from 'fs';
import * as path from 'path';

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { BundlingOptions, NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for LambdaFunctionConstruct
 */
export interface LambdaFunctionConstructProps {
    /** Function name @default auto-generated from namePrefix */
    readonly functionName?: string;

    /** Function description */
    readonly description?: string;

    /** Runtime @default NODEJS_22_X */
    readonly runtime?: lambda.Runtime;

    /**
     * Handler export name (just the export, not the file path).
     * @default 'handler'
     */
    readonly handler?: string;

    /**
     * Path to the TypeScript entry file for esbuild bundling.
     * @example 'lambda/ecs-service-discovery/index.ts'
     */
    readonly entry: string;

    /** Environment variables */
    readonly environment?: Record<string, string>;

    /** Timeout @default 30 seconds */
    readonly timeout?: cdk.Duration;

    /** Memory size in MB @default 256 */
    readonly memorySize?: number;

    /** VPC for running Lambda inside VPC */
    readonly vpc?: ec2.IVpc;

    /** Security groups for VPC Lambda */
    readonly securityGroups?: ec2.ISecurityGroup[];

    /** VPC subnet selection @default PRIVATE_WITH_EGRESS */
    readonly vpcSubnets?: ec2.SubnetSelection;

    /** Enable X-Ray tracing @default ACTIVE */
    readonly tracing?: lambda.Tracing;

    /**
     * Reserved concurrent executions.
     * A value of 0 throttles ALL invocations (effectively disabling the function).
     * @default no limit
     */
    readonly reservedConcurrentExecutions?: number;

    /**
     * Existing IAM role.
     * When provided, `additionalPolicyStatements` are still applied via
     * `addToPrincipalPolicy` (works on both `Role` and `IRole`).
     * @default creates new role
     */
    readonly existingRole?: iam.IRole;

    /** Additional IAM policy statements (applied to both created and existing roles) */
    readonly additionalPolicyStatements?: iam.PolicyStatement[];

    /** Architecture @default ARM_64 */
    readonly architecture?: lambda.Architecture;

    /** Name prefix for resources @default 'monitoring' */
    readonly namePrefix?: string;

    /** Log retention period @default ONE_MONTH */
    readonly logRetention?: logs.RetentionDays;

    /**
     * Dead letter queue for failed async invocations.
     * Accepts `sqs.IQueue` directly — no ARN string needed.
     */
    readonly deadLetterQueue?: sqs.IQueue;

    /** Layers to attach to the function */
    readonly layers?: lambda.ILayerVersion[];

    /**
     * Path to the dependency lock file for esbuild bundling.
     * @default auto-detected (yarn.lock → package-lock.json → pnpm-lock.yaml)
     */
    readonly depsLockFilePath?: string;

    /**
     * Override esbuild bundling options.
     * Merged into defaults — use for banners, defines, native modules, or ESM output.
     *
     * @example
     * ```typescript
     * bundlingOverrides: {
     *     format: OutputFormat.ESM,
     *     banner: '// ESM shim...',
     *     define: { 'process.env.VERSION': JSON.stringify('1.0') },
     * }
     * ```
     */
    readonly bundlingOverrides?: Partial<BundlingOptions>;

    /**
     * KMS key for encrypting CloudWatch log group and Lambda environment variables.
     * When provided, satisfies CKV_AWS_158 (log group KMS) and CKV_AWS_173 (env encryption).
     * @default no encryption (AWS-managed keys)
     */
    readonly encryptionKey?: kms.IKey;
}

/**
 * Reusable Lambda function construct backed by NodejsFunction.
 *
 * Uses CDK's built-in NodejsFunction for automatic TypeScript bundling
 * via esbuild — no manual tryBundle / tsc / size checks needed.
 *
 * @example
 * ```typescript
 * const fn = new LambdaFunctionConstruct(this, 'MyFunction', {
 *     functionName: 'my-processor-development',
 *     entry: 'lambda/my-processor/index.ts',
 *     environment: { TABLE_NAME: table.tableName },
 *     timeout: Duration.minutes(1),
 *     memorySize: 512,
 *     deadLetterQueue: dlq,
 *     additionalPolicyStatements: [
 *         new iam.PolicyStatement({
 *             actions: ['dynamodb:GetItem'],
 *             resources: [table.tableArn],
 *         }),
 *     ],
 * });
 * ```
 */
export class LambdaFunctionConstruct extends Construct {
    /** The Lambda function */
    public readonly function: NodejsFunction;

    /** IAM role for the function */
    public readonly role: iam.IRole;

    /** CloudWatch log group for function logs */
    public readonly logGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: LambdaFunctionConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'monitoring';
        const functionName = props.functionName ?? `${namePrefix}-function`;

        // =================================================================
        // VALIDATION
        // =================================================================
        if (props.reservedConcurrentExecutions === 0) {
            cdk.Annotations.of(this).addWarning(
                'reservedConcurrentExecutions is 0 — this throttles ALL invocations, ' +
                'effectively disabling the function. Set to undefined for no limit.',
            );
        }

        // =================================================================
        // CLOUDWATCH LOG GROUP
        //
        // Created before the Lambda and passed via the logGroup prop so CDK
        // does not auto-create a second one. See module header for migration risk.
        // =================================================================
        this.logGroup = new logs.LogGroup(this, 'LogGroup', {
            logGroupName: `/aws/lambda/${functionName}`,
            retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            ...(props.encryptionKey && { encryptionKey: props.encryptionKey }),
        });

        // =================================================================
        // IAM ROLE
        // =================================================================
        if (props.existingRole) {
            this.role = props.existingRole;
        } else {
            const role = new iam.Role(this, 'ExecutionRole', {
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                description: `Execution role for ${functionName} Lambda function`,
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName(
                        'service-role/AWSLambdaBasicExecutionRole',
                    ),
                ],
            });

            // Add VPC execution role if VPC is specified
            if (props.vpc) {
                role.addManagedPolicy(
                    iam.ManagedPolicy.fromAwsManagedPolicyName(
                        'service-role/AWSLambdaVPCAccessExecutionRole',
                    ),
                );
            }

            this.role = role;
        }

        // Apply additional policy statements to ALL roles (created or existing).
        // Uses addToPrincipalPolicy which works on both Role and IRole.
        // Previously these were only applied inside the else branch — an existing
        // role would silently skip all additional policies.
        if (props.additionalPolicyStatements) {
            for (const statement of props.additionalPolicyStatements) {
                this.role.addToPrincipalPolicy(statement);
            }
        }

        // Grant log group write to ALL roles (created or existing)
        this.logGroup.grantWrite(this.role);

        // =================================================================
        // ENVIRONMENT VARIABLES
        //
        // Source maps are ALWAYS enabled. Caller's NODE_OPTIONS are appended
        // rather than overwriting the source maps flag.
        // =================================================================
        const callerNodeOptions = props.environment?.NODE_OPTIONS;
        const nodeOptions = ['--enable-source-maps', callerNodeOptions]
            .filter(Boolean)
            .join(' ');

        const { NODE_OPTIONS: _ignored, ...restEnvironment } = props.environment ?? {};
        const environment: Record<string, string> = {
            NODE_OPTIONS: nodeOptions,
            ...restEnvironment,
        };

        // =================================================================
        // LOCK FILE DETECTION
        // =================================================================
        const depsLockFilePath = props.depsLockFilePath ?? detectLockFile();

        // =================================================================
        // BUNDLING
        // =================================================================
        const baseBundling: BundlingOptions = {
            sourceMap: true,
            sourcesContent: false,
            format: OutputFormat.CJS,
            target: 'node22',
            externalModules: ['@aws-sdk/*'],
            ...props.bundlingOverrides,
        };

        // =================================================================
        // LAMBDA FUNCTION
        // =================================================================
        this.function = new NodejsFunction(this, 'Function', {
            functionName,
            description: props.description ?? `${namePrefix} Lambda function`,
            runtime: props.runtime ?? lambda.Runtime.NODEJS_22_X,
            handler: props.handler ?? 'handler',
            entry: props.entry,
            depsLockFilePath,
            role: this.role,
            environment,
            timeout: props.timeout ?? cdk.Duration.seconds(30),
            memorySize: props.memorySize ?? 256,
            architecture: props.architecture ?? lambda.Architecture.ARM_64,
            tracing: props.tracing ?? lambda.Tracing.ACTIVE,
            reservedConcurrentExecutions: props.reservedConcurrentExecutions,
            vpc: props.vpc,
            securityGroups: props.securityGroups,
            vpcSubnets: props.vpc
                ? (props.vpcSubnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
                : undefined,
            logGroup: this.logGroup,
            layers: props.layers,
            deadLetterQueue: props.deadLetterQueue,
            bundling: baseBundling,
            ...(props.encryptionKey && { environmentEncryption: props.encryptionKey }),
        });

        // =================================================================
        // TAGS
        //
        // Organizational tags (Environment, Project, Owner, ManagedBy) are
        // applied by TaggingAspect at the app level — not duplicated here.
        // =================================================================
        cdk.Tags.of(this.function).add('Component', 'Lambda');

        // CDK-Nag suppression: NODEJS_22_X is the latest LTS runtime
        // AwsSolutions-L1 may not recognize it as latest yet
        NagSuppressions.addResourceSuppressions(
            this.function,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
                },
            ],
            true,
        );
    }

    /**
     * Grants invoke permission to another principal
     */
    grantInvoke(grantee: iam.IGrantable): iam.Grant {
        return this.function.grantInvoke(grantee);
    }

    /**
     * Adds an environment variable to the function
     */
    addEnvironment(key: string, value: string): void {
        this.function.addEnvironment(key, value);
    }

    /**
     * Returns the function ARN
     */
    get functionArn(): string {
        return this.function.functionArn;
    }

    /**
     * Returns the function name
     */
    get functionName(): string {
        return this.function.functionName;
    }
}

// =========================================================================
// HELPERS
// =========================================================================

/**
 * Auto-detect the dependency lock file.
 *
 * Walks up from cwd toward the filesystem root, checking for
 * yarn.lock → package-lock.json → pnpm-lock.yaml at each level.
 * This supports the monorepo layout where a single yarn.lock lives
 * at the repo root while CDK synth/test runs from the infra/ workspace.
 */
function detectLockFile(): string {
    const candidates = ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'];
    let dir = process.cwd();

    while (true) {
        for (const candidate of candidates) {
            const filePath = path.join(dir, candidate);
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // filesystem root
        dir = parent;
    }

    // Fallback — NodejsFunction will provide a clear error if missing
    return path.join(process.cwd(), 'yarn.lock');
}
