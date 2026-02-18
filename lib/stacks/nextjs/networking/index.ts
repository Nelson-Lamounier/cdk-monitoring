/**
 * @format
 * NextJS Networking Stacks - Central Export
 *
 * Consolidated:
 * - NextJsNetworkingStack: ALB + Target Group + Task Security Group
 *
 * Separate stacks (legacy - use NextJsEdgeStack instead for new deployments):
 * - NextJsApiStack: API Gateway + Lambda
 * - NextJsCloudFrontStack: CloudFront distribution (us-east-1)
 * - NextJsAcmStack: ACM certificate (us-east-1)
 */

// Consolidated Networking Stack
export * from './networking-stack';

// API Stack (separate lifecycle from ECS)
export * from './api-stack';


