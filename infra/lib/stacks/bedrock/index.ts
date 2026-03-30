/**
 * @format
 * Bedrock Stacks - Central Export
 *
 * Provides modular stacks for the Bedrock Agent infrastructure.
 *
 * **8-Stack Architecture**:
 * - DataStack: S3 bucket for Knowledge Base documents
 * - KbStack: Bedrock Knowledge Base backed by Pinecone
 * - AgentStack: Bedrock Agent, Guardrail, Action Group
 * - ApiStack: API Gateway + Lambda for agent invocation
 * - AiContentStack: Article data layer (DynamoDB + SSM exports)
 * - PipelineStack: Multi-agent article pipeline (Step Functions)
 * - StrategistDataStack: Job strategist data layer (DynamoDB)
 * - StrategistPipelineStack: Job strategist pipeline (Step Functions)
 */

export * from './data-stack';
export * from './kb-stack';
export * from './agent-stack';
export * from './api-stack';
export * from './ai-content-stack';
export * from './pipeline-stack';
export * from './strategist-data-stack';
export * from './strategist-pipeline-stack';
