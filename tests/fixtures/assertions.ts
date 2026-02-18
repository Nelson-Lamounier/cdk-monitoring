/**
 * @format
 * Reusable assertion helpers for CDK stack tests
 *
 * Common assertion patterns for Checkov compliance, tagging,
 * and standard CDK resource validation.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';

import { DEFAULT_TAGS } from './constants';

/**
 * Collection of reusable stack assertions
 */
export const StackAssertions = {
    /**
     * Assert that a resource has standard monitoring tags
     */
    hasMonitoringTags(template: Template, resourceType: string): void {
        template.hasResourceProperties(resourceType, {
            Tags: Match.arrayWith([
                Match.objectLike({ Key: 'Purpose', Value: DEFAULT_TAGS.Purpose }),
                Match.objectLike({ Key: 'Application', Value: DEFAULT_TAGS.Application }),
            ]),
        });
    },

    /**
     * Assert that a KMS key has rotation enabled (CKV_AWS_7 compliance)
     */
    hasKmsKeyRotation(template: Template): void {
        template.hasResourceProperties('AWS::KMS::Key', {
            EnableKeyRotation: true,
        });
    },

    /**
     * Assert that a CloudWatch Log Group is encrypted (CKV_AWS_66 compliance)
     */
    hasEncryptedLogGroup(template: Template): void {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            KmsKeyId: Match.anyValue(),
        });
    },

    /**
     * Assert that a CloudWatch Log Group has retention (CKV_AWS_158 compliance)
     */
    hasLogGroupRetention(template: Template): void {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            RetentionInDays: Match.anyValue(),
        });
    },

    /**
     * Assert that a log group has both encryption and retention (full Checkov compliance)
     */
    hasSecureLogGroup(template: Template): void {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            RetentionInDays: Match.anyValue(),
            KmsKeyId: Match.anyValue(),
        });
    },

    /**
     * Assert that an EBS volume is encrypted
     */
    hasEncryptedVolume(template: Template): void {
        template.hasResourceProperties('AWS::EC2::Volume', {
            Encrypted: true,
        });
    },

    /**
     * Assert that an EC2 instance requires IMDSv2
     */
    hasImdsV2Required(template: Template): void {
        template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
            LaunchTemplateData: Match.objectLike({
                MetadataOptions: Match.objectLike({
                    HttpTokens: 'required',
                }),
            }),
        });
    },

    /**
     * Assert that VPC flow logging is enabled (CKV_AWS_111 compliance)
     */
    hasVpcFlowLogs(template: Template): void {
        template.hasResource('AWS::EC2::FlowLog', {
            Properties: Match.objectLike({
                TrafficType: 'ALL',
            }),
        });
    },

    /**
     * Assert that a CloudFormation output exists with optional properties
     */
    hasOutput(
        template: Template,
        outputId: string,
        expectedProps?: { description?: string; exportName?: string; value?: string }
    ): void {
        const matcher: Record<string, unknown> = {};
        if (expectedProps?.description) {
            matcher.Description = expectedProps.description;
        }
        if (expectedProps?.exportName) {
            matcher.Export = { Name: expectedProps.exportName };
        }
        if (expectedProps?.value) {
            matcher.Value = expectedProps.value;
        }
        template.hasOutput(outputId, matcher);
    },

    /**
     * Assert resource count for a given type
     */
    hasResourceCount(template: Template, resourceType: string, count: number): void {
        template.resourceCountIs(resourceType, count);
    },

    /**
     * Assert that a Name tag is applied with expected value
     */
    hasNameTag(template: Template, resourceType: string, expectedName: string): void {
        template.hasResourceProperties(resourceType, {
            Tags: Match.arrayWith([Match.objectLike({ Key: 'Name', Value: expectedName })]),
        });
    },
};

/**
 * Helper to check if ingress rules contain a specific port
 */
export function findIngressRulesByPort(
    template: Template,
    resourceType: 'AWS::EC2::SecurityGroup' | 'AWS::EC2::SecurityGroupIngress',
    port: number
): unknown[] {
    const resources = template.findResources(resourceType);

    if (resourceType === 'AWS::EC2::SecurityGroup') {
        const sgResource = Object.values(resources)[0] as { Properties?: { SecurityGroupIngress?: unknown[] } };
        const ingressRules = sgResource?.Properties?.SecurityGroupIngress || [];
        return (ingressRules as { FromPort?: number }[]).filter((r) => r.FromPort === port);
    }

    // For standalone ingress rules
    return Object.values(resources).filter((r) => {
        const props = (r as { Properties?: { FromPort?: number } }).Properties;
        return props?.FromPort === port;
    });
}

/**
 * Re-export Match for convenience in test files
 */
export { Match } from 'aws-cdk-lib/assertions';
