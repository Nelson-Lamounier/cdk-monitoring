/**
 * @format
 * Security Baseline Stack
 *
 * Enables core AWS security services for the account:
 *   - Amazon GuardDuty (threat detection)
 *   - AWS Security Hub (compliance aggregation)
 *   - IAM Access Analyzer (external access detection)
 *   - AWS CloudTrail (management event audit trail)
 *   - EventBridge (CloudFormation failure detection)
 *
 * Deploy once per account/region. Cost-optimised for solo-developer accounts.
 *
 * @example
 * ```bash
 * npx cdk deploy -c project=shared -c environment=development 'SecurityBaseline-development'
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import type { Environment } from '../../config/environments';
import { AccountSecurityBaselineConstruct } from '../../constructs/security/account-security-baseline';

// =========================================================================
// PROPS
// =========================================================================

/**
 * Props for SecurityBaselineStack.
 */
export interface SecurityBaselineStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** Resource name prefix */
    readonly namePrefix: string;

    /** Optional email for security finding notifications */
    readonly notificationEmail?: string;

    /** Enable GuardDuty @default true */
    readonly enableGuardDuty?: boolean;

    /** Enable Security Hub @default true */
    readonly enableSecurityHub?: boolean;

    /** Enable IAM Access Analyzer @default true */
    readonly enableAccessAnalyzer?: boolean;

    /** Enable CloudTrail management trail @default true */
    readonly enableCloudTrail?: boolean;

    /** Enable EventBridge alerts for CloudFormation failures @default true */
    readonly enableCfnDriftAlerts?: boolean;

    /** S3 log retention in days for CloudTrail @default 90 */
    readonly cloudTrailRetentionDays?: number;
}

// =========================================================================
// STACK
// =========================================================================

/**
 * Security Baseline Stack.
 *
 * Deploys the account-level security services with minimal-cost defaults.
 * This stack should be deployed once per account/region and rarely
 * needs updates.
 *
 * Cost: ~$3–8/month for a small account (security services only).
 * CloudTrail adds ~$0.02/month for S3 storage.
 */
export class SecurityBaselineStack extends cdk.Stack {
    /** The security baseline construct */
    public readonly baseline: AccountSecurityBaselineConstruct;

    /** Target environment this stack was deployed for */
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: SecurityBaselineStackProps) {
        super(scope, id, props);

        this.targetEnvironment = props.targetEnvironment;

        // =================================================================
        // SECURITY BASELINE CONSTRUCT
        // =================================================================
        this.baseline = new AccountSecurityBaselineConstruct(this, 'Baseline', {
            namePrefix: props.namePrefix,
            notificationEmail: props.notificationEmail,
            enableGuardDuty: props.enableGuardDuty,
            enableSecurityHub: props.enableSecurityHub,
            enableAccessAnalyzer: props.enableAccessAnalyzer,
            enableCloudTrail: props.enableCloudTrail,
            enableCfnDriftAlerts: props.enableCfnDriftAlerts,
            cloudTrailRetentionDays: props.cloudTrailRetentionDays,
        });

        // =================================================================
        // CDK-NAG SUPPRESSIONS
        // =================================================================
        if (this.baseline.notificationTopic) {
            NagSuppressions.addResourceSuppressions(
                this.baseline.notificationTopic,
                [
                    {
                        id: 'AwsSolutions-SNS2',
                        reason: 'Security notification topic — no sensitive data in alarm messages, default encryption sufficient',
                    },
                    {
                        id: 'AwsSolutions-SNS3',
                        reason: 'Security notification topic — enforceSSL not required for email-only delivery',
                    },
                ],
            );
        }

        // =================================================================
        // STACK OUTPUTS
        // =================================================================
        if (this.baseline.guardDutyDetector) {
            new cdk.CfnOutput(this, 'GuardDutyDetectorId', {
                description: 'GuardDuty Detector ID',
                value: this.baseline.guardDutyDetector.ref,
            });
        }

        if (this.baseline.accessAnalyzer) {
            new cdk.CfnOutput(this, 'AccessAnalyzerArn', {
                description: 'IAM Access Analyzer ARN',
                value: this.baseline.accessAnalyzer.attrArn,
            });
        }

        if (this.baseline.trail) {
            new cdk.CfnOutput(this, 'CloudTrailArn', {
                description: 'CloudTrail Management Trail ARN',
                value: this.baseline.trail.trailArn,
            });
        }

        if (this.baseline.trailBucket) {
            new cdk.CfnOutput(this, 'CloudTrailBucket', {
                description: 'S3 bucket for CloudTrail logs',
                value: this.baseline.trailBucket.bucketName,
            });
        }

        if (this.baseline.cfnDriftRule) {
            new cdk.CfnOutput(this, 'CfnFailureRuleArn', {
                description: 'EventBridge rule ARN for CloudFormation failure alerts',
                value: this.baseline.cfnDriftRule.ruleArn,
            });
        }

        // =================================================================
        // CDK-NAG SUPPRESSIONS
        // =================================================================
        if (this.baseline.trailBucket) {
            NagSuppressions.addResourceSuppressions(
                this.baseline.trailBucket,
                [
                    {
                        id: 'AwsSolutions-S1',
                        reason: 'CloudTrail log bucket — server access logging not required for a cost-conscious dev account. Trail integrity validated via log file validation.',
                    },
                ],
                true,
            );
        }
    }
}
