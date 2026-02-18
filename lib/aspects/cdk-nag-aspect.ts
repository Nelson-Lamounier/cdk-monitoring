/**
 * @format
 * CDK-Nag Compliance Aspect
 *
 * Implements cdk-nag for validating constructs against security and best practice rules.
 * Supports AWS Solutions, HIPAA, NIST 800-53, and PCI DSS rule packs.
 */

import {
    AwsSolutionsChecks,
    HIPAASecurityChecks,
    NIST80053R5Checks,
    PCIDSS321Checks,
    NagSuppressions,
    NagPackSuppression,
} from 'cdk-nag';

import { Aspects, Stack } from 'aws-cdk-lib/core';

import { IConstruct } from 'constructs';

/**
 * Available compliance packs
 */
export enum CompliancePack {
    /** AWS Solutions - General best practices */
    AWS_SOLUTIONS = 'AwsSolutions',
    /** HIPAA Security - Healthcare compliance */
    HIPAA = 'HIPAA',
    /** NIST 800-53 Rev 5 - Federal security */
    NIST_800_53 = 'NIST800-53',
    /** PCI DSS 3.2.1 - Payment card security */
    PCI_DSS = 'PCI-DSS',
}

/**
 * CDK-Nag configuration options
 */
export interface CdkNagConfig {
    /** Which compliance packs to enable */
    readonly packs?: CompliancePack[];
    /** Whether to include verbose logging */
    readonly verbose?: boolean;
    /** Whether to generate compliance reports */
    readonly reports?: boolean;
}

/** Default configuration */
const DEFAULT_CONFIG: Required<CdkNagConfig> = {
    packs: [CompliancePack.AWS_SOLUTIONS],
    verbose: false,
    reports: true,
};

/**
 * Apply cdk-nag compliance checks to a scope.
 *
 * @example
 * ```typescript
 * // Apply AWS Solutions checks to entire app
 * applyCdkNag(app);
 *
 * // Apply multiple packs with verbose logging
 * applyCdkNag(app, {
 *     packs: [CompliancePack.AWS_SOLUTIONS, CompliancePack.NIST_800_53],
 *     verbose: true,
 * });
 * ```
 */
export function applyCdkNag(scope: IConstruct, config: CdkNagConfig = {}): void {
    const { packs, verbose, reports } = { ...DEFAULT_CONFIG, ...config };

    for (const pack of packs) {
        switch (pack) {
            case CompliancePack.AWS_SOLUTIONS:
                Aspects.of(scope).add(
                    new AwsSolutionsChecks({ verbose, reports })
                );
                break;
            case CompliancePack.HIPAA:
                Aspects.of(scope).add(
                    new HIPAASecurityChecks({ verbose, reports })
                );
                break;
            case CompliancePack.NIST_800_53:
                Aspects.of(scope).add(
                    new NIST80053R5Checks({ verbose, reports })
                );
                break;
            case CompliancePack.PCI_DSS:
                Aspects.of(scope).add(
                    new PCIDSS321Checks({ verbose, reports })
                );
                break;
        }
    }
}

/**
 * Common suppressions for monitoring infrastructure.
 * These are documented exceptions based on the project's security posture.
 */
export const COMMON_SUPPRESSIONS: NagPackSuppression[] = [
    {
        id: 'AwsSolutions-EC23',
        reason: 'Security group allows ingress from specific trusted CIDRs only, not 0.0.0.0/0',
    },
    {
        id: 'AwsSolutions-EC26',
        reason: 'EBS volumes are encrypted with KMS (AWS-managed in dev, CMK in prod)',
    },
    {
        id: 'AwsSolutions-EC28',
        reason: 'Detailed monitoring is optional for cost optimization in dev environment',
    },
    {
        id: 'AwsSolutions-EC29',
        reason: 'Termination protection is disabled for dev/staging to allow easy cleanup',
    },
    {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policies used for SSM and CloudWatch - standard for EC2 monitoring',
    },
    {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for CloudWatch Logs and SSM document execution',
    },
    {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC flow logs are enabled and encrypted with KMS',
    },
];

/**
 * Apply common suppressions to a stack.
 *
 * @example
 * ```typescript
 * applyCommonSuppressions(ec2Stack);
 * ```
 */
export function applyCommonSuppressions(stack: Stack): void {
    NagSuppressions.addStackSuppressions(stack, COMMON_SUPPRESSIONS);
}

