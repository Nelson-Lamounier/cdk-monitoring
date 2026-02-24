/**
 * @format
 * Monitoring SSM Stack
 *
 * Owns the SSM Run Command document and S3 scripts bucket for monitoring
 * configuration. Decoupled from the Compute stack via SSM parameter discovery:
 *
 * - Creates the `configure-monitoring-stack` SSM document
 * - Deploys monitoring stack files (docker-compose, configs) to S3
 * - Writes document name + bucket name to SSM StringParameters
 *
 * The Compute stack reads these parameters at synth time — no cross-stack
 * CloudFormation dependency.
 *
 * Usage:
 *   yarn cli deploy -p monitoring -s ssm
 *   yarn cli reconfigure-monitoring        # triggers the SSM document
 */

import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { SsmRunCommandDocument } from '../../../common/index';
import { S3BucketConstruct } from '../../../common/storage';
import { Environment } from '../../../config';

// =================================================================
// Props
// =================================================================

/**
 * Props for MonitoringSsmStack
 */
export interface MonitoringSsmStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'monitoring-development') */
    readonly namePrefix?: string;

    /** Grafana admin password @default 'admin' */
    readonly grafanaAdminPassword?: string;

    /**
     * Steampipe cross-account connections.
     * Maps connection names to AWS account IDs.
     * The monitoring account uses EC2 instance role (no entry needed).
     */
    readonly steampipeAccounts?: Record<string, string>;
}

// =================================================================
// Stack
// =================================================================

/**
 * SSM Stack for monitoring configuration.
 *
 * Owns the SSM Run Command document and the S3 scripts bucket.
 * Exports discovery parameters so other stacks can reference
 * the document and bucket without cross-stack dependencies.
 *
 * @example
 * ```typescript
 * const ssmStack = new MonitoringSsmStack(app, 'Monitoring-SSM-dev', {
 *     namePrefix: 'monitoring-development',
 *     grafanaAdminPassword: 'secure-password',
 * });
 * ```
 */
export class MonitoringSsmStack extends cdk.Stack {
    /** The SSM document name for monitoring configuration */
    public readonly documentName: string;

    /** S3 bucket for monitoring stack scripts */
    public readonly scriptsBucket: s3.Bucket;

    /** Managed IAM policy with all permissions the SSM document needs at runtime */
    public readonly executionPolicy: iam.ManagedPolicy;

    constructor(scope: Construct, id: string, props: MonitoringSsmStackProps) {
        super(scope, id, props);

        const namePrefix = props.namePrefix ?? 'monitoring';
        const grafanaPassword = props.grafanaAdminPassword ?? 'admin';
        const steampipeAccounts = props.steampipeAccounts ?? {};

        // =================================================================
        // S3 Access Logs Bucket (CKV_AWS_18)
        // =================================================================
        const accessLogsBucketConstruct = new S3BucketConstruct(this, 'ScriptsAccessLogsBucket', {
            environment: Environment.DEVELOPMENT,
            config: {
                bucketName: `${namePrefix}-scripts-logs-${this.account}-${this.region}`,
                purpose: 'monitoring-scripts-access-logs',
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
                lifecycleRules: [{
                    expiration: cdk.Duration.days(90),
                }],
            },
        });

        NagSuppressions.addResourceSuppressions(accessLogsBucketConstruct.bucket, [
            {
                id: 'AwsSolutions-S1',
                reason: 'Access logs bucket cannot log to itself — this is the terminal logging destination',
            },
        ]);

        // =================================================================
        // S3 Bucket for Scripts (to bypass 16KB user data limit)
        // =================================================================
        const scriptsBucketConstruct = new S3BucketConstruct(this, 'ScriptsBucket', {
            environment: Environment.DEVELOPMENT,
            config: {
                bucketName: `${namePrefix}-scripts-${this.account}-${this.region}`,
                purpose: 'monitoring-scripts',
                versioned: true,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
                accessLogsBucket: accessLogsBucketConstruct.bucket,
                accessLogsPrefix: 'scripts-bucket/',
            },
        });
        this.scriptsBucket = scriptsBucketConstruct.bucket;

        // Deploy monitoring stack bundle (docker-compose + configs) to S3
        new s3deploy.BucketDeployment(this, 'ScriptsDeployment', {
            sources: [s3deploy.Source.asset('./scripts/monitoring')],
            destinationBucket: this.scriptsBucket,
            destinationKeyPrefix: 'scripts',
        });

        try {
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`,
                [
                    {
                        id: 'AwsSolutions-L1',
                        reason: 'BucketDeployment Lambda runtime is managed by CDK singleton - cannot override',
                    },
                ],
            );
        } catch {
            // Suppression path may not exist in test environments - this is expected
        }

        // =================================================================
        // SSM Run Command Document: configure-monitoring-stack
        // =================================================================
        this.documentName = `${namePrefix}-configure-monitoring-stack`;

        new SsmRunCommandDocument(this, 'ConfigureMonitoringDoc', {
            documentName: this.documentName,
            description: 'Downloads monitoring stack from S3, configures environment, starts Docker Compose, and registers endpoints in SSM.',
            parameters: {
                S3BucketName: {
                    type: 'String',
                    description: 'S3 bucket containing the monitoring stack archive',
                    default: this.scriptsBucket.bucketName,
                },
                GrafanaPassword: {
                    type: 'String',
                    description: 'Grafana admin password',
                    default: grafanaPassword,
                },
                NamePrefix: {
                    type: 'String',
                    description: 'Name prefix for SSM parameters',
                    default: namePrefix,
                },
                Region: {
                    type: 'String',
                    description: 'AWS region',
                    default: this.region,
                },
                MonitoringDir: {
                    type: 'String',
                    description: 'Directory for monitoring stack',
                    default: '/opt/monitoring',
                },
            },
            steps: [
                {
                    name: 'DownloadMonitoringStack',
                    commands: [
                        'S3_BUCKET="{{ S3BucketName }}"',
                        'REGION="{{ Region }}"',
                        'MONITORING_DIR="{{ MonitoringDir }}"',
                        '',
                        'mkdir -p $MONITORING_DIR',
                        'echo "Downloading monitoring stack from s3://$S3_BUCKET/scripts/..."',
                        'aws s3 cp s3://$S3_BUCKET/scripts/ $MONITORING_DIR/ --recursive --region $REGION',
                        'chmod -R 755 $MONITORING_DIR',
                        'echo "Monitoring stack downloaded to $MONITORING_DIR"',
                    ],
                    workingDirectory: '/tmp',
                    timeoutSeconds: 120,
                },
                {
                    name: 'ConfigureEnvironment',
                    commands: [
                        'GRAFANA_PASS="{{ GrafanaPassword }}"',
                        'MONITORING_DIR="{{ MonitoringDir }}"',
                        'NAME_PREFIX="{{ NamePrefix }}"',
                        'REGION="{{ Region }}"',
                        '',
                        '# Write .env file for docker-compose',
                        'cat > $MONITORING_DIR/.env << ENVEOF',
                        'GF_SECURITY_ADMIN_PASSWORD=$GRAFANA_PASS',
                        'GF_SECURITY_ADMIN_USER=admin',
                        'GF_SERVER_ROOT_URL=http://localhost:3000',
                        'GF_LOG_LEVEL=info',
                        'ENVEOF',
                        '',
                        '# Generate bearer token for Prometheus metrics auth',
                        'mkdir -p $MONITORING_DIR/prometheus/secrets',
                        'mkdir -p $MONITORING_DIR/node-exporter/textfile',
                        'METRICS_TOKEN=$(openssl rand -hex 32)',
                        'echo -n "$METRICS_TOKEN" > $MONITORING_DIR/prometheus/secrets/metrics-token',
                        'chown 65534:65534 $MONITORING_DIR/prometheus/secrets/metrics-token',
                        'chmod 600 $MONITORING_DIR/prometheus/secrets/metrics-token',
                        '',
                        '# Store metrics token in SSM for Next.js app',
                        `aws ssm put-parameter --name "/{{ NamePrefix }}/prometheus/metrics-bearer-token" --value "$METRICS_TOKEN" --type SecureString --overwrite --region {{ Region }}`,
                    ],
                    workingDirectory: '/opt/monitoring',
                    timeoutSeconds: 60,
                },
                {
                    name: 'InstallSteampipePlugins',
                    commands: [
                        'MONITORING_DIR="{{ MonitoringDir }}"',
                        '',
                        '# Steampipe runs inside Docker — install the AWS plugin',
                        '# by exec-ing into the container after it starts.',
                        '# The plugin install happens on first `docker compose up`.',
                        '# Pre-create the plugin directory so the config mount works.',
                        'mkdir -p $MONITORING_DIR/steampipe/config',
                        'chmod -R 755 $MONITORING_DIR/steampipe',
                        'echo "Steampipe config directory prepared"',
                    ],
                    workingDirectory: '/opt/monitoring',
                    timeoutSeconds: 60,
                },
                {
                    name: 'GenerateSteampipeConfig',
                    commands: [
                        'MONITORING_DIR="{{ MonitoringDir }}"',
                        '',
                        '# Generate Steampipe aws.spc dynamically from account map',
                        'mkdir -p $MONITORING_DIR/steampipe/config',
                        '',
                        'cat > $MONITORING_DIR/steampipe/config/aws.spc << \'STEAMPIPE_EOF\'',
                        '# Auto-generated by SSM document — do not edit manually',
                        '# Source: MonitoringSsmStack.GenerateSteampipeConfig',
                        '',
                        '# Aggregator — queries all accounts via: SELECT * FROM aws_all.<table>',
                        'connection "aws_all" {',
                        '  plugin      = "aws"',
                        '  type        = "aggregator"',
                        `  connections = ["aws_monitoring"${Object.keys(steampipeAccounts).length > 0 ? ', ' + Object.keys(steampipeAccounts).map(name => `"aws_${name}"`).join(', ') : ''}]`,
                        '}',
                        '',
                        '# Monitoring account (uses EC2 instance role)',
                        'connection "aws_monitoring" {',
                        '  plugin  = "aws"',
                        '  regions = ["eu-west-1"]',
                        '}',
                        '',
                        ...Object.entries(steampipeAccounts).flatMap(([name, accountId]) => [
                            `connection "aws_${name}" {`,
                            '  plugin   = "aws"',
                            `  regions  = ["eu-west-1"${name.includes('prod') || name.includes('org') ? ', "us-east-1"' : ''}]`,
                            `  role_arn = "arn:aws:iam::${accountId}:role/SteampipeReadOnly"`,
                            '}',
                            '',
                        ]),
                        'STEAMPIPE_EOF',
                        '',
                        'chmod 644 $MONITORING_DIR/steampipe/config/aws.spc',
                        `echo "Steampipe config generated with ${Object.keys(steampipeAccounts).length + 1} connections"`,
                    ],
                    workingDirectory: '/opt/monitoring',
                    timeoutSeconds: 30,
                },
                {
                    name: 'StartMonitoringStack',
                    commands: [
                        'MONITORING_DIR="{{ MonitoringDir }}"',
                        '',
                        '# Wait for Docker AND Docker Compose — user-data installs Docker',
                        '# via dnf, then downloads the Compose v2 plugin from GitHub.',
                        '# We must wait for BOTH to be ready before running docker compose up.',
                        'MAX_WAIT=300',
                        'WAITED=0',
                        'until command -v docker &>/dev/null && docker info &>/dev/null && docker compose version &>/dev/null; do',
                        '  if [ $WAITED -ge $MAX_WAIT ]; then',
                        '    echo "ERROR: Docker/Compose not available after ${MAX_WAIT}s"',
                        '    exit 1',
                        '  fi',
                        '  echo "Waiting for Docker + Compose... (${WAITED}s/${MAX_WAIT}s)"',
                        '  sleep 10',
                        '  WAITED=$((WAITED + 10))',
                        'done',
                        'echo "Docker + Compose ready (waited ${WAITED}s)"',
                        '',
                        'cd $MONITORING_DIR',
                        '',
                        '# Steampipe runs as uid 9193 inside the container and needs',
                        '# write access to its config dir for workspaces.spc.sample.',
                        'if [ -d "$MONITORING_DIR/steampipe/config" ]; then',
                        '  chown -R 9193:0 $MONITORING_DIR/steampipe/config',
                        '  echo "Steampipe config permissions set (uid 9193)"',
                        'fi',
                        '',
                        'docker compose up -d',
                        '',
                        'echo "Monitoring stack started"',
                        '',
                        '# Create systemd service for auto-start on reboot',
                        'cat > /etc/systemd/system/monitoring-stack.service << SYSTEMD_EOF',
                        '[Unit]',
                        'Description=Monitoring Stack (Prometheus + Grafana + Loki)',
                        'Requires=docker.service',
                        'After=docker.service',
                        '',
                        '[Service]',
                        'Type=oneshot',
                        'RemainAfterExit=yes',
                        'WorkingDirectory={{ MonitoringDir }}',
                        'ExecStart=/usr/bin/docker compose up -d',
                        'ExecStop=/usr/bin/docker compose down',
                        '',
                        '[Install]',
                        'WantedBy=multi-user.target',
                        'SYSTEMD_EOF',
                        '',
                        'systemctl daemon-reload',
                        'systemctl enable monitoring-stack.service',
                    ],
                    workingDirectory: '/opt/monitoring',
                    timeoutSeconds: 180,
                },
                {
                    name: 'RegisterEndpointsInSsm',
                    commands: [
                        'NAME_PREFIX="{{ NamePrefix }}"',
                        'REGION="{{ Region }}"',
                        '',
                        '# Get instance private IP via IMDS v2',
                        'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
                        'PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',
                        'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
                        '',
                        '# Loki push endpoint (Promtail sidecar → Loki on this EC2)',
                        'aws ssm put-parameter --name "/$NAME_PREFIX/loki/endpoint" --value "http://$PRIVATE_IP:3100/loki/api/v1/push" --type String --overwrite --region $REGION',
                        '',
                        '# Tempo OTLP endpoint (Alloy sidecar → Tempo on this EC2)',
                        'aws ssm put-parameter --name "/$NAME_PREFIX/tempo/endpoint" --value "http://$PRIVATE_IP:4317" --type String --overwrite --region $REGION',
                        '',
                        'echo "Monitoring endpoints registered in SSM"',
                        'echo "  Loki:  http://$PRIVATE_IP:3100/loki/api/v1/push"',
                        'echo "  Tempo: http://$PRIVATE_IP:4317"',
                    ],
                    workingDirectory: '/tmp',
                    timeoutSeconds: 60,
                },
                {
                    name: 'ConfigureGitHubActionsExporter',
                    commands: [
                        'NAME_PREFIX="{{ NamePrefix }}"',
                        'REGION="{{ Region }}"',
                        'MONITORING_DIR="{{ MonitoringDir }}"',
                        '',
                        '# Fetch GitHub PAT from SSM (SecureString)',
                        `GITHUB_TOKEN=$(aws ssm get-parameter --name "/{{ NamePrefix }}/github/api-token" --with-decryption --query "Parameter.Value" --output text --region {{ Region }} 2>/dev/null || echo "")`,
                        'if [ -n "$GITHUB_TOKEN" ]; then',
                        '    echo "GITHUB_TOKEN=$GITHUB_TOKEN" >> $MONITORING_DIR/.env',
                        '    echo "GITHUB_REPOS=Nelson-Lamounier/cdk-monitoring,Nelson-Lamounier/PortfolioWebsite" >> $MONITORING_DIR/.env',
                        '    cd $MONITORING_DIR && docker compose up -d github-actions-exporter',
                        '    echo "GitHub Actions Exporter configured with SSM token"',
                        'else',
                        `    echo "WARNING: SSM parameter /{{ NamePrefix }}/github/api-token not found"`,
                        'fi',
                    ],
                    workingDirectory: '/opt/monitoring',
                    timeoutSeconds: 60,
                },
            ],
            tags: [
                { key: 'Project', value: namePrefix },
                { key: 'Purpose', value: 'configure-monitoring-stack' },
            ],
        });

        // =================================================================
        // Managed IAM Policy: SSM Document Execution
        //
        // Contains ALL permissions the SSM document's steps need at runtime.
        // The Compute stack imports this policy ARN and attaches it to the
        // instance role — keeping the SSM stack fully independent.
        // =================================================================
        this.executionPolicy = new iam.ManagedPolicy(this, 'SsmExecutionPolicy', {
            managedPolicyName: `${namePrefix}-ssm-execution-policy`,
            description: 'Permissions required by the monitoring SSM document at runtime',
            statements: [
                // Step 1 (DownloadMonitoringStack): S3 read for scripts bucket
                new iam.PolicyStatement({
                    sid: 'S3ReadScripts',
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:GetObject', 's3:ListBucket'],
                    resources: [
                        this.scriptsBucket.bucketArn,
                        `${this.scriptsBucket.bucketArn}/*`,
                    ],
                }),
                // Step 2 (ConfigureEnvironment): Write Prometheus bearer token
                new iam.PolicyStatement({
                    sid: 'SsmWriteBearerToken',
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:PutParameter'],
                    resources: [
                        `arn:aws:ssm:${this.region}:${this.account}:parameter/${namePrefix}/prometheus/metrics-bearer-token`,
                    ],
                }),
                // Step 4 (RegisterEndpointsInSsm): Write Loki + Tempo endpoints
                new iam.PolicyStatement({
                    sid: 'SsmWriteEndpoints',
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:PutParameter'],
                    resources: [
                        `arn:aws:ssm:${this.region}:${this.account}:parameter/${namePrefix}/loki/endpoint`,
                        `arn:aws:ssm:${this.region}:${this.account}:parameter/${namePrefix}/tempo/endpoint`,
                    ],
                }),
                // Step 5 (ConfigureGitHubActionsExporter): Read GitHub PAT
                new iam.PolicyStatement({
                    sid: 'SsmReadGitHubToken',
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:GetParameter'],
                    resources: [
                        `arn:aws:ssm:${this.region}:${this.account}:parameter/${namePrefix}/github/api-token`,
                    ],
                }),
                // SSM Run Command: self-trigger and status check
                new iam.PolicyStatement({
                    sid: 'SsmRunCommandExecution',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'ssm:SendCommand',
                        'ssm:GetCommandInvocation',
                        'ssm:DescribeInstanceInformation',
                    ],
                    resources: [
                        `arn:aws:ssm:${this.region}:${this.account}:document/${this.documentName}`,
                        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
                        `arn:aws:ssm:${this.region}:*:*`,
                    ],
                }),
                // Step: Steampipe cross-account governance
                // Allows the monitoring instance to assume SteampipeReadOnly roles
                // in target accounts for multi-account SQL queries
                new iam.PolicyStatement({
                    sid: 'SteampipeCrossAccountAssumeRole',
                    effect: iam.Effect.ALLOW,
                    actions: ['sts:AssumeRole'],
                    resources: ['arn:aws:iam::*:role/SteampipeReadOnly'],
                }),
            ],
        });

        // =================================================================
        // SSM Discovery Parameters
        //
        // Other stacks (Compute) read these at synth time to discover
        // the document name, bucket, and policy — no cross-stack dependency.
        // =================================================================
        new ssm.StringParameter(this, 'DocumentNameParam', {
            parameterName: `/${namePrefix}/ssm/document-name`,
            stringValue: this.documentName,
            description: 'SSM Run Command document name for monitoring configuration',
        });

        new ssm.StringParameter(this, 'ScriptsBucketParam', {
            parameterName: `/${namePrefix}/ssm/scripts-bucket-name`,
            stringValue: this.scriptsBucket.bucketName,
            description: 'S3 bucket name containing monitoring stack scripts',
        });

        new ssm.StringParameter(this, 'ExecutionPolicyArnParam', {
            parameterName: `/${namePrefix}/ssm/execution-policy-arn`,
            stringValue: this.executionPolicy.managedPolicyArn,
            description: 'IAM policy ARN with all permissions for SSM document execution',
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'SsmDocumentName', {
            value: this.documentName,
            description: 'SSM Run Command document name',
        });

        new cdk.CfnOutput(this, 'ScriptsBucketName', {
            value: this.scriptsBucket.bucketName,
            description: 'S3 bucket containing monitoring stack scripts',
        });

        new cdk.CfnOutput(this, 'ExecutionPolicyArn', {
            value: this.executionPolicy.managedPolicyArn,
            description: 'IAM policy ARN for SSM document execution',
        });
    }
}
