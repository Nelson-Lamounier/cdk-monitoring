/**
 * @format
 * NextJS Stacks - Central Export
 *
 * Domain-based Consolidated Stacks:
 * - NextJsDataStack (ECR + DynamoDB + S3 + Secrets)
 * - NextJsNetworkingStack (ALB + Task Security Group)
 * - NextJsComputeStack (ECS Cluster + IAM Roles)
 * - NextJsApplicationStack (Task Definition + Service + AutoDeploy)
 * - NextJsEdgeStack (ACM + WAF + CloudFront) - us-east-1 only
 *
 * NOTE: K8s compute moved to lib/stacks/kubernetes/compute-stack.ts
 */

// ============================================================================
// CONSOLIDATED DOMAIN STACKS
// ============================================================================

// Data Domain (ECR + DynamoDB + S3 + Secrets)
export * from './data';

// Compute Domain (ECS Cluster + IAM Roles)
export * from './compute';

// Application Domain (Task Definition + Service + AutoDeploy)
export * from './application';

// Networking Domain (ALB + Task Security Group)
export * from './networking';

// Edge Domain (ACM + WAF + CloudFront) - MUST be deployed in us-east-1
export * from './edge';

// ============================================================================
// API Stack
// ============================================================================
