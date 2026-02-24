/**
 * @format
 * Next.js Project - Central Export
 *
 * NextJSProjectFactory: Domain-based stacks (6 stacks)
 * - DataStack: ECR + DynamoDB + S3 + SSM Secrets
 * - ComputeStack: ECS Cluster + IAM Roles + ASG
 * - NetworkingStack: ALB + Target Group + Task Security Group
 * - ApplicationStack: Task Definition + Service + AutoDeploy
 * - ApiStack: API Gateway + Lambda
 * - EdgeStack: ACM + WAF + CloudFront (optional, us-east-1)
 *
 * Stacks are in lib/stacks/nextjs/.
 */

export {
    ConsolidatedNextJSFactory,
    ConsolidatedNextJSFactory as NextJSProjectFactory,
    ConsolidatedFactoryContext,
} from './factory';

export type { ConsolidatedFactoryContext as NextJSFactoryContext } from './factory';
