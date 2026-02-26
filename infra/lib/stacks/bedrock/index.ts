/**
 * @format
 * Bedrock Stacks - Central Export
 *
 * Provides modular stacks for the Bedrock Agent infrastructure.
 *
 * **3-Stack Architecture**:
 * - DataStack: S3 bucket for Knowledge Base documents
 * - AgentStack: Bedrock Agent, Knowledge Base, Guardrail, Action Group
 * - ApiStack: API Gateway + Lambda for agent invocation
 */

export * from './data-stack';
export * from './agent-stack';
export * from './api-stack';
