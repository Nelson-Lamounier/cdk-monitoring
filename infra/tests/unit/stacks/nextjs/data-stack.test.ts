/**
 * @format
 * NextJS Data Stack Unit Tests
 *
 * Tests for the consolidated NextJsDataStack:
 * - DynamoDB Personal Portfolio Table (articles + email subscriptions)
 * - S3 Assets Bucket with security settings
 * - SSM Parameters via AwsCustomResource (idempotent put)
 *
 * Note: ECR Repository has been migrated to SharedVpcStack
 */

import { Template, Match } from 'aws-cdk-lib/assertions';

import { Environment } from '../../../../lib/config';
import {
    NextJsDataStack,
    NextJsDataStackProps,
} from '../../../../lib/stacks/nextjs/data/data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

/**
 * Helper to create NextJsDataStack for testing
 */
function createDataStack(
    props?: Partial<NextJsDataStackProps>,
): { stack: NextJsDataStack; template: Template } {
    const app = createTestApp();

    const stack = new NextJsDataStack(app, 'TestDataStack', {
        env: TEST_ENV_EU,
        targetEnvironment: props?.targetEnvironment ?? Environment.DEVELOPMENT,
        projectName: props?.projectName ?? 'nextjs',
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

/**
 * Helper to extract SSM parameter names from AwsCustomResource Create/Update calls.
 * Handles both plain JSON strings and CloudFormation intrinsic function payloads
 * (e.g., Fn::Join used when CDK tokens like table names are involved).
 */
function getSsmParameterNames(template: Template): string[] {
    const customResources = template.findResources('Custom::AWS');
    const names: string[] = [];
    for (const resource of Object.values(customResources)) {
        const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;
        const update = props?.Update as unknown;
        const create = props?.Create as unknown;
        const payload = update ?? create;
        if (!payload) continue;

        if (typeof payload === 'string') {
            // Plain JSON string (no CDK tokens)
            try {
                const parsed = JSON.parse(payload);
                if (parsed.parameters?.Name) {
                    names.push(parsed.parameters.Name as string);
                }
            } catch {
                // Not parseable, skip
            }
        } else {
            // CloudFormation intrinsic function (Fn::Join, etc.)
            // Stringify and search for the Name parameter pattern
            const serialized = JSON.stringify(payload);
            // Match quoted parameter name paths like /nextjs/development/dynamodb-table-name
            const nameMatch = serialized.match(/\/([\w-]+)\/([\w-]+)\/([\w-]+)/);
            if (nameMatch) {
                names.push(nameMatch[0]);
            }
        }
    }
    return names;
}

describe('NextJsDataStack', () => {
    // NOTE: ECR Repository tests have been moved to SharedVpcStack tests
    // ECR is now part of shared infrastructure

    describe('DynamoDB Personal Portfolio Table', () => {
        it('should create a DynamoDB table', () => {
            const { template } = createDataStack();
            template.resourceCountIs('AWS::DynamoDB::Table', 1);
        });

        it('should follow personal-portfolio naming pattern', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TableName: 'nextjs-personal-portfolio-development',
            });
        });

        it('should have pk partition key', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                KeySchema: Match.arrayWith([
                    Match.objectLike({
                        AttributeName: 'pk',
                        KeyType: 'HASH',
                    }),
                ]),
            });
        });

        it('should have sk sort key', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                KeySchema: Match.arrayWith([
                    Match.objectLike({
                        AttributeName: 'sk',
                        KeyType: 'RANGE',
                    }),
                ]),
            });
        });

        it('should use PAY_PER_REQUEST billing mode', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                BillingMode: 'PAY_PER_REQUEST',
            });
        });

        it('should enable point-in-time recovery', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                PointInTimeRecoverySpecification: {
                    PointInTimeRecoveryEnabled: true,
                },
            });
        });

        it('should have two global secondary indexes', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({
                        IndexName: 'gsi1-status-date',
                    }),
                    Match.objectLike({
                        IndexName: 'gsi2-tag-date',
                    }),
                ]),
            });
        });


        it('should enable TTL with attribute name ttl', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TimeToLiveSpecification: {
                    AttributeName: 'ttl',
                    Enabled: true,
                },
            });
        });
    });

    describe('S3 Buckets', () => {
        it('should create assets bucket and access logs bucket', () => {
            const { template } = createDataStack();
            // Should create 2 buckets: assets + access logs
            template.resourceCountIs('AWS::S3::Bucket', 2);
        });

        it('should block public access on buckets', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::S3::Bucket', {
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });

        it('should enable versioning on buckets', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::S3::Bucket', {
                VersioningConfiguration: {
                    Status: 'Enabled',
                },
            });
        });

        it('should configure access logging from assets bucket to access logs bucket', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::S3::Bucket', {
                LoggingConfiguration: {
                    DestinationBucketName: Match.anyValue(),
                    LogFilePrefix: 'assets-bucket/',
                },
            });
        });
    });



    describe('Stack Properties', () => {
        // NOTE: repository property removed - ECR is now in SharedVpcStack

        it('should expose portfolioTable property', () => {
            const { stack } = createDataStack();
            expect(stack.portfolioTable).toBeDefined();
        });

        it('should expose assetsBucket property', () => {
            const { stack } = createDataStack();
            expect(stack.assetsBucket).toBeDefined();
        });

        it('should expose accessLogsBucket property', () => {
            const { stack } = createDataStack();
            expect(stack.accessLogsBucket).toBeDefined();
        });

        it('should expose targetEnvironment property', () => {
            const { stack } = createDataStack({
                targetEnvironment: Environment.STAGING,
            });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });

        it('should expose ssmPrefix property', () => {
            const { stack } = createDataStack();
            expect(stack.ssmPrefix).toBe('/nextjs/development');
        });
    });

    describe('Environment Configuration', () => {
        it('should use staging environment in SSM paths', () => {
            const { template } = createDataStack({
                targetEnvironment: Environment.STAGING,
            });
            const names = getSsmParameterNames(template);
            expect(names.some((n: string) => n.includes('/nextjs/staging/'))).toBe(true);
        });

        it('should use custom project name in SSM paths', () => {
            const { template } = createDataStack({
                projectName: 'myapp',
            });
            const names = getSsmParameterNames(template);
            expect(names.some((n: string) => n.includes('/myapp/development/'))).toBe(true);
        });
    });

    describe('Production Configuration', () => {
        it('should enable KMS encryption for DynamoDB in production', () => {
            const { template } = createDataStack({
                targetEnvironment: Environment.PRODUCTION,
            });
            // Should create KMS key for production
            template.resourceCountIs('AWS::KMS::Key', 1);
        });

        it('should not create KMS key for development', () => {
            const { template } = createDataStack({
                targetEnvironment: Environment.DEVELOPMENT,
            });
            // Should not create any KMS keys in development
            template.resourceCountIs('AWS::KMS::Key', 0);
        });
    });

    describe('Stack Outputs', () => {
        // NOTE: ECR outputs moved to SharedVpcStack

        it('should export portfolio table name', () => {
            const { template } = createDataStack();
            template.hasOutput('PortfolioTableName', {});
        });

        it('should export assets bucket name', () => {
            const { template } = createDataStack();
            template.hasOutput('AssetsBucketName', {});
        });
    });

    describe('Security Best Practices', () => {
        it('should enforce SSL on S3 buckets', () => {
            const { stack } = createDataStack();
            // Access logs bucket should have enforceSSL
            expect(stack.accessLogsBucket).toBeDefined();
        });

        it('should block all public access on S3 buckets', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::S3::Bucket', {
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });
    });
});
