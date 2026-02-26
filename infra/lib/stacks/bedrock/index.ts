/**
 * @format
 * Bedrock Stacks - Central Export
 *
 * Provides modular stacks for the Bedrock Agent infrastructure.
 *
 * **4-Stack Architecture**:
 * - DataStack: S3 bucket for Knowledge Base documents
 * - AgentStack: Bedrock Agent, Knowledge Base, Guardrail, Action Group
 * - ApiStack: API Gateway + Lambda for agent invocation
 * - AiContentStack: MD-to-Blog pipeline (S3 event → Lambda → DynamoDB)
 */

export * from './data-stack';
export * from './agent-stack';
export * from './api-stack';
export * from './ai-content-stack';
