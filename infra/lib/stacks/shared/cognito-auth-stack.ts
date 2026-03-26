/**
 * @format
 * Cognito Auth Stack
 *
 * AWS Cognito User Pool for admin authentication.
 * Replaces the previous Auth.js v5 Credentials provider that suffered from
 * Edge Runtime incompatibilities (jose/CompressionStream) and CSRF issues
 * behind CloudFront.
 *
 * ## Architecture
 * ```
 * Browser → /admin/login → signIn('cognito') → Cognito Hosted UI
 *         → OAuth callback → /api/auth/callback/cognito → next-auth session
 * ```
 *
 * ## Resources Created
 * 1. **UserPool** — Self-sign-up disabled, email verification required
 * 2. **UserPoolClient** — OAuth 2.0 Authorization Code flow
 * 3. **UserPoolDomain** — Cognito Hosted UI domain
 * 4. **Admin User** — Pre-created via CfnUserPoolUser
 * 5. **SSM Parameters** — User Pool ID, Client ID, Issuer URL, Domain
 */

import { NagSuppressions } from 'cdk-nag';

import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Configuration props for CognitoAuthStack.
 *
 * @example
 * ```typescript
 * new CognitoAuthStack(app, 'CognitoAuth', {
 *     namePrefix: 'portfolio-admin',
 *     adminEmail: 'admin@example.com',
 *     callbackUrls: ['https://nelsonlamounier.com/api/auth/callback/cognito'],
 *     logoutUrls: ['https://nelsonlamounier.com'],
 *     removalPolicy: cdk.RemovalPolicy.RETAIN,
 *     env: { region: 'eu-west-1', account: '607700977986' },
 * });
 * ```
 */
export interface CognitoAuthStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'portfolio-admin') */
    readonly namePrefix: string;

    /** Admin user email address for the pre-created user */
    readonly adminEmail: string;

    /** OAuth callback URLs (must include Next.js auth callback) */
    readonly callbackUrls: string[];

    /** OAuth logout redirect URLs */
    readonly logoutUrls: string[];

    /** SSM parameter path prefix for exporting Cognito outputs */
    readonly ssmPrefix: string;

    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * CognitoAuthStack — Managed admin authentication via AWS Cognito.
 *
 * Creates a minimal User Pool with a single pre-seeded admin user.
 * Self-sign-up is disabled to ensure only invited users can authenticate.
 * OAuth 2.0 Authorization Code flow integrates with next-auth's Cognito provider.
 */
export class CognitoAuthStack extends cdk.Stack {
    /** The Cognito User Pool */
    public readonly userPool: cognito.UserPool;

    /** The User Pool OAuth client */
    public readonly userPoolClient: cognito.UserPoolClient;

    /** The Hosted UI domain */
    public readonly userPoolDomain: cognito.UserPoolDomain;

    /** The Cognito Issuer URL */
    public readonly issuerUrl: string;

    constructor(scope: Construct, id: string, props: CognitoAuthStackProps) {
        super(scope, id, {
            ...props,
            description: `Cognito admin authentication for ${props.namePrefix}`,
        });

        const { namePrefix, ssmPrefix } = props;

        // =================================================================
        // User Pool — Admin-only, no self-sign-up
        // =================================================================
        this.userPool = new cognito.UserPool(this, 'AdminUserPool', {
            userPoolName: `${namePrefix}-admin-pool`,
            selfSignUpEnabled: false,
            signInAliases: { email: true },
            autoVerify: { email: true },
            standardAttributes: {
                email: {
                    required: true,
                    mutable: false,
                },
            },
            passwordPolicy: {
                minLength: 12,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
                tempPasswordValidity: cdk.Duration.days(7),
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: props.removalPolicy,
            mfa: cognito.Mfa.OPTIONAL,
            mfaSecondFactor: {
                sms: false,
                otp: true,
            },
        });

        // CDK-Nag: Suppress advanced security mode requirement for a
        // single-user portfolio authentication pool.
        NagSuppressions.addResourceSuppressions(
            this.userPool,
            [{
                id: 'AwsSolutions-COG2',
                reason: 'MFA is optional for single-admin portfolio User Pool; advanced security mode not cost-justified',
            }],
            true,
        );

        // =================================================================
        // User Pool Client — OAuth 2.0 Authorization Code flow
        // =================================================================
        this.userPoolClient = this.userPool.addClient('NextJsClient', {
            userPoolClientName: `${namePrefix}-nextjs-client`,
            generateSecret: false,
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                },
                scopes: [
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.PROFILE,
                ],
                callbackUrls: props.callbackUrls,
                logoutUrls: props.logoutUrls,
            },
            authFlows: {
                userSrp: true,
            },
            preventUserExistenceErrors: true,
            supportedIdentityProviders: [
                cognito.UserPoolClientIdentityProvider.COGNITO,
            ],
        });

        // =================================================================
        // Hosted UI Domain
        // =================================================================
        this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
            cognitoDomain: {
                domainPrefix: namePrefix,
            },
        });

        // =================================================================
        // Pre-create Admin User
        //
        // The user receives a temporary password at their email.
        // On first login, they MUST change the password.
        // =================================================================
        new cognito.CfnUserPoolUser(this, 'AdminUser', {
            userPoolId: this.userPool.userPoolId,
            username: props.adminEmail,
            userAttributes: [
                {
                    name: 'email',
                    value: props.adminEmail,
                },
                {
                    name: 'email_verified',
                    value: 'true',
                },
            ],
            desiredDeliveryMediums: ['EMAIL'],
        });

        // =================================================================
        // Derived Values
        // =================================================================
        this.issuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;

        const hostedUiDomain = `${namePrefix}.auth.${this.region}.amazoncognito.com`;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'UserPoolIdParam', {
            parameterName: `${ssmPrefix}/auth/cognito-user-pool-id`,
            stringValue: this.userPool.userPoolId,
            description: `Cognito User Pool ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ClientIdParam', {
            parameterName: `${ssmPrefix}/auth/cognito-client-id`,
            stringValue: this.userPoolClient.userPoolClientId,
            description: `Cognito Client ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'IssuerUrlParam', {
            parameterName: `${ssmPrefix}/auth/cognito-issuer-url`,
            stringValue: this.issuerUrl,
            description: `Cognito Issuer URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'DomainParam', {
            parameterName: `${ssmPrefix}/auth/cognito-domain`,
            stringValue: hostedUiDomain,
            description: `Cognito Hosted UI domain for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.userPool.userPoolId,
            description: 'Cognito User Pool ID',
        });

        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: this.userPoolClient.userPoolClientId,
            description: 'Cognito User Pool Client ID',
        });

        new cdk.CfnOutput(this, 'HostedUiDomain', {
            value: hostedUiDomain,
            description: 'Cognito Hosted UI domain',
        });

        new cdk.CfnOutput(this, 'IssuerUrl', {
            value: this.issuerUrl,
            description: 'Cognito OIDC Issuer URL',
        });
    }
}
