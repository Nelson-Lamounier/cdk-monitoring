/**
 * @format
 * API Gateway Construct
 *
 * Reusable REST API Gateway construct with built-in:
 * - CloudWatch logging (JSON structured access logs)
 * - CORS configuration (caller must specify allowMethods explicitly)
 * - Stage-level throttling
 * - Lambda integration helper with path caching
 *
 * Configuration is externalized — no hard-coded values.
 * All settings come from props or project-specific config.
 *
 * Design notes:
 * - Request validation: The construct creates a request validator that checks both
 *   body and parameters. However, body validation is a no-op unless the caller passes
 *   `requestModels` in `addLambdaIntegration` options. Without a model, API Gateway
 *   has nothing to validate against — the validator exists to satisfy AwsSolutions-APIG2.
 * - Method-level throttling and usage plans are not supported by this construct.
 *   Stage-level throttling covers the common case. For per-client quotas or per-method
 *   rate limits, create a usage plan outside this construct and associate it with the
 *   API stage.
 * - Tag strategy: Only `Component: ApiGateway` is applied here. Organizational tags
 *   (Environment, Project, Owner, ManagedBy) come from TaggingAspect at app level.
 *
 * @example
 * ```typescript
 * const api = new ApiGatewayConstruct(this, 'Api', {
 *     apiName: 'articles-api',
 *     environment: Environment.PRODUCTION,
 *     cors: {
 *         allowOrigins: ['https://example.com'],
 *         allowMethods: ['GET', 'POST', 'OPTIONS'],
 *     },
 *     throttle: { rateLimit: 100, burstLimit: 200 },
 * });
 *
 * // Lambda integration (proxy mode by default)
 * api.addLambdaIntegration('GET', '/articles', listArticlesLambda);
 *
 * // With request body validation
 * api.addLambdaIntegration('POST', '/subscriptions', subscribeLambda, {
 *     requestModels: { 'application/json': subscriptionModel },
 * });
 *
 * // Non-Lambda integration using resolved resource
 * const resource = api.resolveResource('/health');
 * resource.addMethod('GET', mockIntegration);
 * ```
 */

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../../config/environments';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Throttle configuration for API Gateway (stage-level).
 *
 * For method-level throttling, create a usage plan outside this construct
 * and associate method-level throttle overrides with it.
 */
export interface ThrottleProps {
    readonly rateLimit: number;
    readonly burstLimit: number;
}

/**
 * CORS configuration for API Gateway.
 *
 * `allowMethods` is required — the construct does not default to ALL_METHODS
 * because allowing DELETE/PUT via CORS when no endpoint uses them increases
 * the attack surface. Specify only the methods your API actually supports.
 */
export interface CorsProps {
    readonly allowOrigins: readonly string[];
    /** HTTP methods to allow. Specify only methods your API supports. */
    readonly allowMethods: readonly string[];
    readonly allowHeaders?: readonly string[];
    readonly allowCredentials?: boolean;
    readonly maxAge?: cdk.Duration;
}

/**
 * Options for addLambdaIntegration
 */
export interface LambdaIntegrationOptions {
    /**
     * Request models for body validation. Without this, `validateRequestBody`
     * on the request validator is a no-op — API Gateway has nothing to validate against.
     *
     * @example { 'application/json': subscriptionModel }
     */
    readonly requestModels?: { [contentType: string]: apigateway.IModel };

    /**
     * Use proxy integration (pass raw API Gateway event to Lambda).
     * Set to false to use request/response mapping templates.
     * @default true
     */
    readonly proxy?: boolean;
}

/**
 * Props for ApiGatewayConstruct
 */
export interface ApiGatewayConstructProps {
    /** API name (used in resource naming) */
    readonly apiName: string;

    /** Target environment */
    readonly environment: Environment;

    /** API description @default Generated from apiName */
    readonly description?: string;

    /** Stage name @default 'api' */
    readonly stageName?: string;

    /** CORS configuration — allowMethods is required to avoid overly permissive defaults */
    readonly cors?: CorsProps;

    /** Stage-level throttling configuration */
    readonly throttle?: ThrottleProps;

    /** Enable CloudWatch logging @default true */
    readonly enableLogging?: boolean;

    /** Log retention @default ONE_MONTH */
    readonly logRetention?: logs.RetentionDays;

    /** Enable X-Ray tracing @default false */
    readonly enableTracing?: boolean;

    /** Enable detailed CloudWatch metrics @default false */
    readonly enableDetailedMetrics?: boolean;

    /** Enable KMS encryption for access logs @default false */
    readonly enableLogEncryption?: boolean;

    /** Name prefix for resources */
    readonly namePrefix?: string;

    /** Removal policy @default DESTROY */
    readonly removalPolicy?: cdk.RemovalPolicy;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Reusable API Gateway REST API construct.
 *
 * Features:
 * - CloudWatch logging with configurable retention and optional KMS encryption
 * - CORS configuration (caller-specified methods only)
 * - Stage-level throttling with configurable limits
 * - X-Ray tracing (optional)
 * - Lambda integration helper with path caching
 * - Public resource resolution for non-Lambda integrations
 *
 * Does NOT create CfnOutput — consuming stacks decide what to export.
 */
export class ApiGatewayConstruct extends Construct {
    /** The REST API */
    public readonly api: apigateway.RestApi;

    /** CloudWatch Log Group for API access logs */
    public readonly accessLogGroup?: logs.LogGroup;

    /** KMS key for access log encryption */
    public readonly logEncryptionKey?: kms.Key;

    /**
     * Request validator for API methods.
     *
     * Validates both request body and parameters. However, body validation
     * only works when `requestModels` is provided via `addLambdaIntegration`.
     * Without a model, `validateRequestBody: true` is a no-op — the validator
     * satisfies AwsSolutions-APIG2 but provides no runtime protection.
     */
    public readonly requestValidator: apigateway.RequestValidator;

    /** Map of resource paths to API resources (path caching) */
    private readonly resources: Map<string, apigateway.IResource> = new Map();

    constructor(scope: Construct, id: string, props: ApiGatewayConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'api';
        const stageName = props.stageName ?? 'api';
        const enableLogging = props.enableLogging ?? true;
        const logRetention = props.logRetention ?? logs.RetentionDays.ONE_MONTH;
        const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;
        const enableLogEncryption = props.enableLogEncryption ?? false;

        // =====================================================================
        // KMS KEY FOR ACCESS LOG ENCRYPTION (CKV_AWS_158)
        // =====================================================================
        if (enableLogging && enableLogEncryption) {
            this.logEncryptionKey = new kms.Key(this, 'AccessLogKey', {
                description: `KMS key for API Gateway access logs - ${props.apiName}`,
                enableKeyRotation: true,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            });

            // Grant CloudWatch Logs permission to use the key.
            // In a KMS key policy, resources: ['*'] means "this key" — key policies
            // are always implicitly scoped to their own key ARN. This is standard
            // KMS policy syntax, not a wildcard over all keys.
            this.logEncryptionKey.addToResourcePolicy(
                new iam.PolicyStatement({
                    actions: [
                        'kms:Encrypt*',
                        'kms:Decrypt*',
                        'kms:ReEncrypt*',
                        'kms:GenerateDataKey*',
                        'kms:Describe*',
                    ],
                    principals: [
                        new iam.ServicePrincipal(`logs.${cdk.Aws.REGION}.amazonaws.com`),
                    ],
                    resources: ['*'], // "this key" in KMS key policy context
                    conditions: {
                        ArnLike: {
                            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
                        },
                    },
                })
            );
        }

        // =====================================================================
        // ACCESS LOG GROUP
        // =====================================================================
        if (enableLogging) {
            this.accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
                logGroupName: `/aws/apigateway/${namePrefix}-${props.apiName}-${props.environment}`,
                retention: logRetention,
                encryptionKey: this.logEncryptionKey,
                removalPolicy,
            });
        }

        // =====================================================================
        // ENHANCED ACCESS LOG FORMAT
        //
        // Only constructed when logging is enabled — avoids unnecessary
        // JSON.stringify and AccessLogFormat allocation when disabled.
        // =====================================================================
        let accessLogDestination: apigateway.IAccessLogDestination | undefined;
        let accessLogFormat: apigateway.AccessLogFormat | undefined;

        if (enableLogging && this.accessLogGroup) {
            accessLogFormat = apigateway.AccessLogFormat.custom(
                JSON.stringify({
                    requestId: apigateway.AccessLogField.contextRequestId(),
                    ip: apigateway.AccessLogField.contextIdentitySourceIp(),
                    userAgent: apigateway.AccessLogField.contextIdentityUserAgent(),
                    requestTime: apigateway.AccessLogField.contextRequestTime(),
                    httpMethod: apigateway.AccessLogField.contextHttpMethod(),
                    resourcePath: apigateway.AccessLogField.contextResourcePath(),
                    status: apigateway.AccessLogField.contextStatus(),
                    protocol: apigateway.AccessLogField.contextProtocol(),
                    responseLength: apigateway.AccessLogField.contextResponseLength(),
                    responseLatency: apigateway.AccessLogField.contextResponseLatency(),
                    integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
                    xrayTraceId: '$context.xrayTraceId',
                    errorMessage: '$context.error.message',
                })
            );
            accessLogDestination = new apigateway.LogGroupLogDestination(this.accessLogGroup);
        }

        // =====================================================================
        // REST API
        // =====================================================================
        this.api = new apigateway.RestApi(this, 'RestApi', {
            restApiName: `${namePrefix}-${props.apiName}-${props.environment}`,
            description: props.description ?? `${props.apiName} REST API for ${props.environment}`,
            deployOptions: {
                stageName,
                tracingEnabled: props.enableTracing ?? false,
                metricsEnabled: props.enableDetailedMetrics ?? false,
                loggingLevel: enableLogging
                    ? apigateway.MethodLoggingLevel.INFO
                    : apigateway.MethodLoggingLevel.OFF,
                accessLogDestination,
                accessLogFormat,
                throttlingRateLimit: props.throttle?.rateLimit,
                throttlingBurstLimit: props.throttle?.burstLimit,
            },
            defaultCorsPreflightOptions: props.cors
                ? {
                    allowOrigins: [...props.cors.allowOrigins],
                    allowMethods: [...props.cors.allowMethods],
                    allowHeaders: props.cors.allowHeaders
                        ? [...props.cors.allowHeaders]
                        : apigateway.Cors.DEFAULT_HEADERS,
                    allowCredentials: props.cors.allowCredentials ?? false,
                    maxAge: props.cors.maxAge,
                }
                : undefined,
            endpointTypes: [apigateway.EndpointType.REGIONAL],
        });

        // =====================================================================
        // CLOUDWATCH LOGS ROLE — DEPENDENCY FIX
        //
        // CDK's RestApi auto-creates a CfnAccount + IAM role for CloudWatch
        // Logs (cloudWatchRole defaults to true). However, CloudFormation may
        // deploy the Stage before the CfnAccount is applied, causing:
        //   "CloudWatch Logs role ARN must be set in account settings"
        //
        // Fix: add an explicit dependency from the deployment stage to CDK's
        // auto-created Account resource so the role is registered first.
        // =====================================================================
        if (enableLogging) {
            const account = this.api.node.tryFindChild('Account');
            if (account) {
                this.api.deploymentStage.node.addDependency(account);
            }
        }

        // Store root resource
        this.resources.set('/', this.api.root);

        // =====================================================================
        // REQUEST VALIDATOR (AwsSolutions-APIG2)
        // =====================================================================
        this.requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
            restApi: this.api,
            requestValidatorName: `${namePrefix}-validator-${props.environment}`,
            validateRequestBody: true,
            validateRequestParameters: true,
        });

        // =====================================================================
        // TAGGING
        //
        // Organizational tags (Environment, Project, Owner, ManagedBy) are
        // applied by TaggingAspect at the app level — not duplicated here.
        // =====================================================================
        cdk.Tags.of(this.api).add('Component', 'ApiGateway');
    }

    /**
     * Add a Lambda integration to a path.
     *
     * The construct's request validator is automatically attached. For body
     * validation to be effective, you **must** pass `requestModels` in the
     * options — without a model, `validateRequestBody` is a no-op.
     *
     * @param method HTTP method (GET, POST, etc.)
     * @param path Resource path (e.g., '/articles/{slug}')
     * @param handler Lambda function to integrate
     * @param options Integration options (requestModels, proxy mode)
     * @returns The created API Gateway Method
     */
    addLambdaIntegration(
        method: string,
        path: string,
        handler: lambda.IFunction,
        options?: LambdaIntegrationOptions,
    ): apigateway.Method {
        const resource = this.resolveResource(path);
        const integration = new apigateway.LambdaIntegration(handler, {
            proxy: options?.proxy ?? true,
        });

        return resource.addMethod(method, integration, {
            requestValidator: this.requestValidator,
            ...(options?.requestModels && { requestModels: options.requestModels }),
        });
    }

    /**
     * Resolve a resource for a path, creating intermediate segments as needed.
     *
     * Handles nested paths like '/articles/{slug}/comments' by walking each
     * segment and caching resolved resources for reuse. This avoids the CDK
     * pain point where nested paths require manual resource chaining.
     *
     * Useful for non-Lambda integrations (mock, HTTP proxy, etc.) where
     * callers need the resource to call `addMethod` directly.
     *
     * @param path Resource path (e.g., '/articles/{slug}')
     * @returns The resolved API Gateway resource
     *
     * @throws Error if a path parameter conflicts with an existing sibling
     *   (e.g., adding '/articles/{id}' when '/articles/{slug}' exists)
     */
    resolveResource(path: string): apigateway.IResource {
        // Normalize path
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;

        // Return cached resource if exists
        if (this.resources.has(normalizedPath)) {
            return this.resources.get(normalizedPath)!;
        }

        // Build path parts
        const parts = normalizedPath.split('/').filter(p => p.length > 0);
        let currentResource: apigateway.IResource = this.api.root;
        let currentPath = '';

        for (const part of parts) {
            currentPath = `${currentPath}/${part}`;

            if (this.resources.has(currentPath)) {
                currentResource = this.resources.get(currentPath)!;
            } else {
                // Validate path parameter conflicts:
                // If adding '{id}' and '{slug}' already exists at this level,
                // CDK will throw an opaque error at synth time. Catch it early.
                if (part.startsWith('{') && part.endsWith('}')) {
                    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
                    for (const [existingPath] of this.resources) {
                        if (existingPath.startsWith(parentPath + '/')) {
                            const existingPart = existingPath.substring(parentPath.length + 1).split('/')[0];
                            if (
                                existingPart &&
                                existingPart.startsWith('{') &&
                                existingPart.endsWith('}') &&
                                existingPart !== part
                            ) {
                                throw new Error(
                                    `Path parameter conflict at '${currentPath}': ` +
                                    `'${part}' conflicts with existing '${existingPart}'. ` +
                                    `API Gateway does not allow different path parameters at the same level.`,
                                );
                            }
                        }
                    }
                }

                currentResource = currentResource.addResource(part);
                this.resources.set(currentPath, currentResource);
            }
        }

        return currentResource;
    }

    /**
     * Get the API execution URL
     */
    get url(): string {
        return this.api.url;
    }
}
