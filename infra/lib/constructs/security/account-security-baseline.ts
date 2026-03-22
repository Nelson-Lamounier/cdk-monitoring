/**
 * @format
 * Account Security Baseline Construct
 *
 * L3 construct that enables core AWS security services with
 * minimal-cost defaults for a solo-developer account.
 *
 * Services:
 *   - Amazon GuardDuty (threat detection — VPC/CloudTrail only)
 *   - AWS Security Hub  (CIS Foundations standard)
 *   - IAM Access Analyzer (account-level, free)
 *
 * Cost target: ~$3–8/month for a small account.
 *
 * @example
 * ```typescript
 * new AccountSecurityBaselineConstruct(this, 'SecurityBaseline', {
 *     namePrefix: 'k8s',
 *     notificationEmail: 'alerts@example.com',
 * });
 * ```
 */

import * as accessanalyzer from 'aws-cdk-lib/aws-accessanalyzer';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =========================================================================
// PROPS
// =========================================================================

/**
 * Configuration for the Account Security Baseline construct.
 */
export interface AccountSecurityBaselineProps {
    /** Resource name prefix for consistent naming */
    readonly namePrefix: string;

    /** Enable Amazon GuardDuty threat detection @default true */
    readonly enableGuardDuty?: boolean;

    /** Enable AWS Security Hub compliance checking @default true */
    readonly enableSecurityHub?: boolean;

    /** Enable IAM Access Analyzer @default true */
    readonly enableAccessAnalyzer?: boolean;

    /**
     * GuardDuty finding publishing frequency.
     * FIFTEEN_MINUTES is the most responsive; ONE_HOUR/SIX_HOURS reduce cost.
     * @default FIFTEEN_MINUTES
     */
    readonly findingPublishingFrequency?: string;

    /**
     * Enable GuardDuty S3 protection (data event analysis).
     * Adds cost — disable for minimal spend.
     * @default false
     */
    readonly enableS3Protection?: boolean;

    /**
     * Enable GuardDuty EKS audit log monitoring.
     * Not needed for kubeadm clusters.
     * @default false
     */
    readonly enableEksProtection?: boolean;

    /**
     * Enable GuardDuty malware protection.
     * Adds significant cost — disable for minimal spend.
     * @default false
     */
    readonly enableMalwareProtection?: boolean;

    /**
     * Enable GuardDuty RDS login activity monitoring.
     * @default false
     */
    readonly enableRdsProtection?: boolean;

    /**
     * Enable GuardDuty Lambda network activity monitoring.
     * @default false
     */
    readonly enableLambdaProtection?: boolean;

    /**
     * Enable GuardDuty Runtime Monitoring (ECS/EC2/EKS).
     * @default false
     */
    readonly enableRuntimeMonitoring?: boolean;

    /**
     * Enable CloudTrail management trail.
     * 1 free management trail per region — no additional cost.
     * Logs to an S3 bucket with lifecycle expiry.
     * @default true
     */
    readonly enableCloudTrail?: boolean;

    /**
     * S3 log retention in days for CloudTrail.
     * Shorter retention reduces storage cost.
     * @default 90
     */
    readonly cloudTrailRetentionDays?: number;

    /**
     * Enable EventBridge alerts for CloudFormation deployment failures.
     * Catches UPDATE_ROLLBACK_COMPLETE, UPDATE_ROLLBACK_FAILED,
     * CREATE_FAILED, UPDATE_FAILED, and DELETE_FAILED events.
     * Sends notifications to the security SNS topic.
     * @default true
     */
    readonly enableCfnDriftAlerts?: boolean;

    /**
     * Optional email address for security finding notifications.
     * Creates an SNS topic and subscribes this email.
     * Also used by CloudTrail and drift detection alerts.
     */
    readonly notificationEmail?: string;
}

// =========================================================================
// CONSTRUCT
// =========================================================================

/**
 * Account-level security baseline construct.
 *
 * Enables GuardDuty, Security Hub, and IAM Access Analyzer with
 * cost-optimised defaults suitable for a solo-developer AWS account.
 *
 * All optional GuardDuty data sources are disabled by default to
 * minimise cost. Core threat detection (VPC Flow Logs + CloudTrail
 * management events) is always active.
 *
 * Features:
 * - Feature flags for each service (all enabled by default)
 * - GuardDuty with granular data source control
 * - Security Hub with auto-enabled controls
 * - IAM Access Analyzer (account scope — free)
 * - Optional SNS email notifications for findings
 */
export class AccountSecurityBaselineConstruct extends Construct {
    /** The GuardDuty detector (undefined if disabled) */
    public readonly guardDutyDetector?: guardduty.CfnDetector;

    /** The Security Hub hub (undefined if disabled) */
    public readonly securityHub?: securityhub.CfnHub;

    /** The IAM Access Analyzer (undefined if disabled) */
    public readonly accessAnalyzer?: accessanalyzer.CfnAnalyzer;

    /** The CloudTrail trail (undefined if disabled) */
    public readonly trail?: cloudtrail.Trail;

    /** The CloudTrail S3 bucket (undefined if CloudTrail disabled) */
    public readonly trailBucket?: s3.Bucket;

    /** The EventBridge rule for CloudFormation failures (undefined if disabled) */
    public readonly cfnDriftRule?: events.Rule;

    /** The SNS topic for security notifications (undefined if no email provided) */
    public readonly notificationTopic?: sns.Topic;

    constructor(scope: Construct, id: string, props: AccountSecurityBaselineProps) {
        super(scope, id);

        const enableGuardDuty = props.enableGuardDuty ?? true;
        const enableSecurityHub = props.enableSecurityHub ?? true;
        const enableAccessAnalyzer = props.enableAccessAnalyzer ?? true;
        const enableCloudTrail = props.enableCloudTrail ?? true;
        const enableCfnDriftAlerts = props.enableCfnDriftAlerts ?? true;
        const cloudTrailRetentionDays = props.cloudTrailRetentionDays ?? 90;

        // =================================================================
        // SNS TOPIC (optional — for security finding notifications)
        // =================================================================
        if (props.notificationEmail) {
            this.notificationTopic = new sns.Topic(this, 'SecurityFindingsTopic', {
                displayName: `${props.namePrefix} Security Findings`,
            });

            this.notificationTopic.addSubscription(
                new sns_subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        // =================================================================
        // AMAZON GUARDDUTY
        //
        // Core threat detection analyses VPC Flow Logs and CloudTrail
        // management events at no extra charge beyond the base detector.
        // All optional data sources (S3, EKS, Malware, RDS, Lambda,
        // Runtime Monitoring) are disabled by default to minimise cost.
        // =================================================================
        if (enableGuardDuty) {
            this.guardDutyDetector = new guardduty.CfnDetector(this, 'GuardDutyDetector', {
                enable: true,
                findingPublishingFrequency: props.findingPublishingFrequency ?? 'FIFTEEN_MINUTES',
                features: [
                    {
                        name: 'S3_DATA_EVENTS',
                        status: (props.enableS3Protection ?? false) ? 'ENABLED' : 'DISABLED',
                    },
                    {
                        name: 'EKS_AUDIT_LOGS',
                        status: (props.enableEksProtection ?? false) ? 'ENABLED' : 'DISABLED',
                    },
                    {
                        name: 'EBS_MALWARE_PROTECTION',
                        status: (props.enableMalwareProtection ?? false) ? 'ENABLED' : 'DISABLED',
                    },
                    {
                        name: 'RDS_LOGIN_EVENTS',
                        status: (props.enableRdsProtection ?? false) ? 'ENABLED' : 'DISABLED',
                    },
                    {
                        name: 'LAMBDA_NETWORK_LOGS',
                        status: (props.enableLambdaProtection ?? false) ? 'ENABLED' : 'DISABLED',
                    },
                    {
                        name: 'RUNTIME_MONITORING',
                        status: (props.enableRuntimeMonitoring ?? false) ? 'ENABLED' : 'DISABLED',
                    },
                ],
                tags: [
                    { key: 'Name', value: `${props.namePrefix}-guardduty` },
                ],
            });
        }

        // =================================================================
        // AWS SECURITY HUB
        //
        // Aggregates findings from GuardDuty, Access Analyzer, and
        // Inspector. Auto-enable controls is on; consolidated findings
        // reduces duplicate noise. Standards are enabled separately —
        // only CIS Foundations is recommended for minimal cost.
        // =================================================================
        if (enableSecurityHub) {
            this.securityHub = new securityhub.CfnHub(this, 'SecurityHub', {
                autoEnableControls: true,
                controlFindingGenerator: 'SECURITY_CONTROL',
                enableDefaultStandards: false,
                tags: { Name: `${props.namePrefix}-securityhub` },
            });
        }

        // =================================================================
        // IAM ACCESS ANALYZER
        //
        // Account-level analyser that identifies resources shared with
        // external entities. This is completely free for account scope.
        // =================================================================
        if (enableAccessAnalyzer) {
            this.accessAnalyzer = new accessanalyzer.CfnAnalyzer(this, 'AccessAnalyzer', {
                analyzerName: `${props.namePrefix}-access-analyzer`,
                type: 'ACCOUNT',
                tags: [
                    { key: 'Name', value: `${props.namePrefix}-access-analyzer` },
                ],
            });
        }
        // =================================================================
        // AWS CLOUDTRAIL — Management Events Trail
        //
        // 1 free management trail per region. Logs all API calls
        // (CreateStack, DeleteTopic, RunInstances, etc.) for forensic
        // audit. S3 bucket uses lifecycle rules to control cost.
        //
        // Cost: ~$0.02/month for S3 storage on a small account.
        // =================================================================
        if (enableCloudTrail) {
            this.trailBucket = new s3.Bucket(this, 'CloudTrailBucket', {
                bucketName: `${props.namePrefix}-cloudtrail-logs`,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
                lifecycleRules: [
                    {
                        id: 'ExpireOldLogs',
                        expiration: cdk.Duration.days(cloudTrailRetentionDays),
                        enabled: true,
                    },
                ],
            });

            this.trail = new cloudtrail.Trail(this, 'ManagementTrail', {
                trailName: `${props.namePrefix}-management-trail`,
                bucket: this.trailBucket,
                isMultiRegionTrail: false,
                includeGlobalServiceEvents: true,
                enableFileValidation: true,
                sendToCloudWatchLogs: false, // Disabled by default — adds ~$0.50/month
            });
        }

        // =================================================================
        // EVENTBRIDGE — CloudFormation Failure Detection
        //
        // Catches CloudFormation stack state changes that indicate
        // deployment failures. Sends a formatted email via the shared
        // security SNS topic for immediate visibility.
        //
        // Events captured:
        //   - UPDATE_ROLLBACK_COMPLETE (deployment failed, rolled back)
        //   - UPDATE_ROLLBACK_FAILED  (stuck — requires manual fix)
        //   - UPDATE_FAILED           (update could not complete)
        //   - CREATE_FAILED           (stack creation failed)
        //   - DELETE_FAILED           (stack deletion failed)
        //
        // Cost: Free (default event bus + SNS email).
        // =================================================================
        if (enableCfnDriftAlerts && this.notificationTopic) {
            this.cfnDriftRule = new events.Rule(this, 'CfnFailureRule', {
                ruleName: `${props.namePrefix}-cfn-failure-alerts`,
                description: 'Alerts on CloudFormation deployment failures for proactive drift detection',
                eventPattern: {
                    source: ['aws.cloudformation'],
                    detailType: ['CloudFormation Stack Status Change'],
                    detail: {
                        'status-details': {
                            status: [
                                'UPDATE_ROLLBACK_COMPLETE',
                                'UPDATE_ROLLBACK_FAILED',
                                'UPDATE_FAILED',
                                'CREATE_FAILED',
                                'DELETE_FAILED',
                            ],
                        },
                    },
                },
            });

            this.cfnDriftRule.addTarget(
                new eventsTargets.SnsTopic(this.notificationTopic, {
                    message: events.RuleTargetInput.fromText(
                        `⚠️ CloudFormation Deployment Failure\n\n` +
                        `Stack: ${events.EventField.fromPath('$.detail.stack-id')}\n` +
                        `Status: ${events.EventField.fromPath('$.detail.status-details.status')}\n` +
                        `Time: ${events.EventField.fromPath('$.time')}\n\n` +
                        `Check the AWS Console for details and remediation steps.`,
                    ),
                }),
            );
        }
    }
}
