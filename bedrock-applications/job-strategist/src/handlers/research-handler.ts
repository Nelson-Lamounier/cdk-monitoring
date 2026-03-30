/**
 * @format
 * Research Handler — Step Functions Entry Point
 *
 * Lambda handler invoked by Step Functions as the first stage
 * in the strategist pipeline. Receives the StrategistPipelineContext,
 * executes the Research Agent, and returns the result for the
 * Strategist Handler.
 *
 * Input: { context: StrategistPipelineContext }
 * Output: { context: StrategistPipelineContext, research: AgentResult<StrategistResearchResult> }
 */

import { executeResearchAgent } from '../agents/research-agent.js';
import type {
    StrategistResearchHandlerInput,
    StrategistWriterHandlerInput,
} from '../../../shared/src/index.js';

/**
 * Lambda handler for the Strategist Research Agent.
 *
 * @param event - Step Functions input with StrategistPipelineContext
 * @returns Updated context and research result for the Strategist stage
 */
export const handler = async (
    event: StrategistResearchHandlerInput,
): Promise<StrategistWriterHandlerInput> => {
    console.log(
        `[strategist-research-handler] Pipeline ${event.context.pipelineId} ` +
        `— role: ${event.context.targetRole}`,
    );

    const research = await executeResearchAgent(event.context);

    return {
        context: event.context,
        research,
    };
};
