/**
 * @format
 * Cognito Auth Stack Unit Tests
 *
 * Tests for the CognitoAuthStack:
 * - User Pool with correct settings (no self-sign-up, email sign-in)
 * - User Pool Client with OAuth Authorization Code flow
 * - User Pool Domain with expected prefix
 * - Admin user pre-created
 * - SSM parameter exports for all 4 paths
 * - Stack outputs defined
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { CognitoAuthStack } from '../../../../lib/stacks/shared/cognito-auth-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'portfolio-admin';
const SSM_PREFIX = '/nextjs/development';

/**
 * Helper to create CognitoAuthStack with sensible defaults.
 */
function createCognitoStack(
    overrides?: Partial<ConstructorParameters<typeof CognitoAuthStack>[2]>,
): { stack: CognitoAuthStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new CognitoAuthStack(
        app,
        'TestCognitoAuthStack',
        {
            namePrefix: NAME_PREFIX,
            adminEmail: 'test@example.com',
            callbackUrls: [
                'https://nelsonlamounier.com/api/auth/callback/cognito',
                'http://localhost:3000/api/auth/callback/cognito',
            ],
            logoutUrls: [
                'https://nelsonlamounier.com',
                'http://localhost:3000',
            ],
            ssmPrefix: SSM_PREFIX,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            env: TEST_ENV_EU,
            ...overrides,
        },
    );

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('CognitoAuthStack', () => {

    // =========================================================================
    // User Pool
    // =========================================================================
    describe('User Pool', () => {
        const { template } = createCognitoStack();

        it('should create a User Pool with correct name', () => {
            template.hasResourceProperties('AWS::Cognito::UserPool', {
                UserPoolName: `${NAME_PREFIX}-admin-pool`,
            });
        });

        it('should disable self-sign-up', () => {
            template.hasResourceProperties('AWS::Cognito::UserPool', {
                AdminCreateUserConfig: Match.objectLike({
                    AllowAdminCreateUserOnly: true,
                }),
            });
        });

        it('should enable email sign-in', () => {
            template.hasResourceProperties('AWS::Cognito::UserPool', {
                UsernameAttributes: Match.arrayWith(['email']),
            });
        });

        it('should require email verification', () => {
            template.hasResourceProperties('AWS::Cognito::UserPool', {
                AutoVerifiedAttributes: Match.arrayWith(['email']),
            });
        });

        it('should enforce strong password policy', () => {
            template.hasResourceProperties('AWS::Cognito::UserPool', {
                Policies: Match.objectLike({
                    PasswordPolicy: Match.objectLike({
                        MinimumLength: 12,
                        RequireLowercase: true,
                        RequireUppercase: true,
                        RequireNumbers: true,
                        RequireSymbols: true,
                    }),
                }),
            });
        });

        it('should enforce advanced security mode', () => {
            template.hasResourceProperties('AWS::Cognito::UserPool', {
                UserPoolAddOns: Match.objectLike({
                    AdvancedSecurityMode: 'ENFORCED',
                }),
            });
        });
    });

    // =========================================================================
    // User Pool Client
    // =========================================================================
    describe('User Pool Client', () => {
        const { template } = createCognitoStack();

        it('should create a client with correct name', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
                ClientName: `${NAME_PREFIX}-nextjs-client`,
            });
        });

        it('should not generate a client secret', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
                GenerateSecret: false,
            });
        });

        it('should configure OAuth Authorization Code flow', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
                AllowedOAuthFlows: Match.arrayWith(['code']),
            });
        });

        it('should configure OAuth scopes', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
                AllowedOAuthScopes: Match.arrayWith([
                    'openid',
                    'email',
                    'profile',
                ]),
            });
        });

        it('should set callback URLs', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
                CallbackURLs: Match.arrayWith([
                    'https://nelsonlamounier.com/api/auth/callback/cognito',
                    'http://localhost:3000/api/auth/callback/cognito',
                ]),
            });
        });

        it('should prevent user existence errors', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
                PreventUserExistenceErrors: 'ENABLED',
            });
        });
    });

    // =========================================================================
    // User Pool Domain
    // =========================================================================
    describe('User Pool Domain', () => {
        const { template } = createCognitoStack();

        it('should create a Hosted UI domain with correct prefix', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
                Domain: NAME_PREFIX,
            });
        });
    });

    // =========================================================================
    // Admin User
    // =========================================================================
    describe('Admin User', () => {
        const { template } = createCognitoStack();

        it('should pre-create an admin user', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolUser', {
                Username: 'test@example.com',
            });
        });

        it('should set email delivery for temporary password', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolUser', {
                DesiredDeliveryMediums: ['EMAIL'],
            });
        });

        it('should mark email as verified', () => {
            template.hasResourceProperties('AWS::Cognito::UserPoolUser', {
                UserAttributes: Match.arrayWith([
                    Match.objectLike({
                        Name: 'email_verified',
                        Value: 'true',
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createCognitoStack();

        it('should export User Pool ID via SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `${SSM_PREFIX}/auth/cognito-user-pool-id`,
            });
        });

        it('should export Client ID via SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `${SSM_PREFIX}/auth/cognito-client-id`,
            });
        });

        it('should export Issuer URL via SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `${SSM_PREFIX}/auth/cognito-issuer-url`,
            });
        });

        it('should export domain via SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `${SSM_PREFIX}/auth/cognito-domain`,
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createCognitoStack();

        it('should output the User Pool ID', () => {
            template.hasOutput('UserPoolId', {});
        });

        it('should output the Client ID', () => {
            template.hasOutput('UserPoolClientId', {});
        });

        it('should output the Hosted UI domain', () => {
            template.hasOutput('HostedUiDomain', {});
        });

        it('should output the Issuer URL', () => {
            template.hasOutput('IssuerUrl', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createCognitoStack();

        it('should expose userPool', () => {
            expect(stack.userPool).toBeDefined();
        });

        it('should expose userPoolClient', () => {
            expect(stack.userPoolClient).toBeDefined();
        });

        it('should expose userPoolDomain', () => {
            expect(stack.userPoolDomain).toBeDefined();
        });

        it('should expose issuerUrl', () => {
            expect(stack.issuerUrl).toBeDefined();
            expect(stack.issuerUrl).toContain('cognito-idp');
        });
    });
});
