/**
 * @format
 * Strategist Handler — Step Functions Stage 2
 *
 * Lambda handler invoked by Step Functions as the second stage.
 * Receives research results, executes the Strategist Agent for
 * the 5-phase analysis, and returns results for the Coach Handler.
 *
 * Input: { context, research }
 * Output: { context, research, analysis }
 */

import { executeStrategistAgent } from '../agents/strategist-agent.js';
import type {
    StrategistWriterHandlerInput,
    StrategistCoachHandlerInput,
} from '../../../shared/src/index.js';

/**
 * Lambda handler for the Strategist Agent.
 *
 * @param event - Step Functions input with research results
 * @returns Updated context with full XML analysis
 */
export const handler = async (
    event: StrategistWriterHandlerInput,
): Promise<StrategistCoachHandlerInput> => {
    console.log(
        `[strategist-writer-handler] Pipeline ${event.context.pipelineId} ` +
        `— generating analysis for "${event.context.targetRole}"`,
    );

    const analysis = await executeStrategistAgent(event.context, event.research.data);

    return {
        context: event.context,
        research: event.research,
        analysis,
    };
};
