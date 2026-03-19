/**
 * @format
 * Security Baseline Stack
 *
 * Enables core AWS security services for the account:
 *   - Amazon GuardDuty (threat detection)
 *   - AWS Security Hub (compliance aggregation)
 *   - IAM Access Analyzer (external access detection)
 *
 * Deploy once per account/region. Cost-optimised for solo-developer accounts.
 *
 * @example
 * ```bash
 * npx cdk deploy -c project=shared -c environment=development 'SecurityBaseline-development'
 * ```
 */

import * as cdk from 'aws-cdk-lib/core';
import { NagSuppressions } from 'cdk-nag';

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
 * Cost: ~$3–8/month for a small account with default settings.
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
    }
}
