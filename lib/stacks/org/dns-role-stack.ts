/**
 * @format
 * Cross-Account DNS Validation Role Stack
 *
 * Deploy this stack in your ROOT account where the Route 53 hosted zone exists.
 * Creates an IAM role that target accounts can assume to create
 * DNS validation records for ACM certificates.
 *
 * This follows the pattern where application-specific IAM roles live in stacks,
 * not reusable constructs (same pattern as NextJsIamRolesStack).
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for CrossAccountDnsRoleStack
 */
export interface CrossAccountDnsRoleStackProps extends cdk.StackProps {
    /**
     * Route 53 Hosted Zone ID(s) to allow access to
     * @example ['Z1234567890ABC'] or ['Z123...', 'Z456...']
     */
    readonly hostedZoneIds: string[];

    /**
     * AWS account IDs that are allowed to assume this role
     * These are your dev, staging, and prod account IDs
     * @example ['111111111111', '222222222222']
     */
    readonly trustedAccountIds: string[];

    /**
     * Role name
     * @default 'Route53DnsValidationRole'
     */
    readonly roleName?: string;

    /**
     * External ID for additional security (optional)
     * Target accounts must provide this when assuming the role
     * @example 'acm-dns-validation'
     */
    readonly externalId?: string;

    /**
     * Resource name prefix
     * @default 'dns-validation'
     */
    readonly namePrefix?: string;
}

/**
 * Cross-Account DNS Validation Role Stack
 *
 * Deploy this stack in the ROOT account to allow target accounts
 * (dev/staging/prod) to create DNS validation records for ACM certificates.
 *
 * @example
 * ```typescript
 * // Deploy in root account
 * const dnsRoleStack = new CrossAccountDnsRoleStack(app, 'DnsValidationRole', {
 *     hostedZoneIds: ['Z1234567890ABC'],
 *     trustedAccountIds: ['111111111111', '222222222222', '333333333333'],
 *     externalId: 'acm-dns-validation',
 *     env: { account: 'ROOT_ACCOUNT_ID', region: 'eu-west-2' },
 * });
 *
 * // Then in target accounts, use:
 * // crossAccountRoleArn: 'arn:aws:iam::ROOT_ACCOUNT_ID:role/Route53DnsValidationRole'
 * ```
 */
export class CrossAccountDnsRoleStack extends cdk.Stack {
    /** The IAM role */
    public readonly role: iam.Role;

    /** The role ARN (for use in target accounts) */
    public readonly roleArn: string;

    /** The role name */
    public readonly roleName: string;

    constructor(scope: Construct, id: string, props: CrossAccountDnsRoleStackProps) {
        super(scope, id, props);

        // =================================================================
        // VALIDATION
        // =================================================================
        if (!props.hostedZoneIds || props.hostedZoneIds.length === 0) {
            throw new Error('hostedZoneIds is required and must contain at least one hosted zone ID');
        }

        if (!props.trustedAccountIds || props.trustedAccountIds.length === 0) {
            throw new Error('trustedAccountIds is required and must contain at least one account ID');
        }

        // =================================================================
        // CONFIGURATION
        // =================================================================
        const namePrefix = props.namePrefix ?? 'dns-validation';
        this.roleName = props.roleName ?? 'Route53DnsValidationRole';

        // =================================================================
        // TRUST POLICY
        // =================================================================
        const trustPrincipals = props.trustedAccountIds.map(
            (accountId) => new iam.AccountPrincipal(accountId),
        );

        // =================================================================
        // IAM ROLE
        // =================================================================
        this.role = new iam.Role(this, 'DnsValidationRole', {
            roleName: this.roleName,
            description: 'Allows target accounts to create DNS validation records for ACM certificates',
            assumedBy: new iam.CompositePrincipal(...trustPrincipals),
            maxSessionDuration: cdk.Duration.hours(1),
        });

        // Add external ID condition if provided
        if (props.externalId) {
            const cfnRole = this.role.node.defaultChild as iam.CfnRole;
            cfnRole.addPropertyOverride(
                'AssumeRolePolicyDocument.Statement.0.Condition',
                {
                    StringEquals: {
                        'sts:ExternalId': props.externalId,
                    },
                },
            );
        }

        this.roleArn = this.role.roleArn;

        // =================================================================
        // ROUTE 53 PERMISSIONS
        // =================================================================
        const hostedZoneArns = props.hostedZoneIds.map(
            (zoneId) => `arn:aws:route53:::hostedzone/${zoneId}`,
        );

        // Allow creating/deleting DNS validation records
        this.role.addToPolicy(
            new iam.PolicyStatement({
                sid: 'Route53DnsValidation',
                effect: iam.Effect.ALLOW,
                actions: [
                    'route53:ChangeResourceRecordSets',
                    'route53:ListResourceRecordSets',
                ],
                resources: hostedZoneArns,
            }),
        );

        // Allow listing hosted zones (for validation)
        this.role.addToPolicy(
            new iam.PolicyStatement({
                sid: 'Route53ListZones',
                effect: iam.Effect.ALLOW,
                actions: ['route53:ListHostedZones'],
                resources: ['*'],
            }),
        );

        // =================================================================
        // STACK OUTPUTS
        // =================================================================
        new cdk.CfnOutput(this, 'RoleArnOutput', {
            value: this.roleArn,
            description: 'Cross-account DNS validation role ARN (use in target accounts)',
            exportName: `${namePrefix}-role-arn`,
        });

        new cdk.CfnOutput(this, 'RoleNameOutput', {
            value: this.roleName,
            description: 'Cross-account DNS validation role name',
        });

        // =================================================================
        // COMPONENT-SPECIFIC TAGS
        // =================================================================
        cdk.Tags.of(this).add('Component', 'DNS-Validation-Role');
        cdk.Tags.of(this).add('Purpose', 'Cross-Account-ACM-Validation');
    }
}
