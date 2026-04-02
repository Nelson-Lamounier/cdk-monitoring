/**
 * @format
 * Strategist Handler — Analysis Pipeline Stage 2
 *
 * Lambda handler invoked by Step Functions as the second stage
 * of the analysis pipeline. Receives research results, executes
 * the Strategist Agent for the 5-phase analysis, and returns
 * results for the Resume Builder / Analysis Persist handlers.
 *
 * **Payload trimming:** After the Strategist Agent completes, the
 * downstream stages no longer need `jobDescription`, `resumeData`,
 * or the full research `thinking` text. These are stripped from the
 * return payload to stay under the Step Functions 256KB limit.
 *
 * Input: { context, research }
 * Output: { context (trimmed), research (trimmed), analysis }
 */

import { executeStrategistAgent } from '../agents/strategist-agent.js';
import type {
    StrategistWriterHandlerInput,
    StrategistAnalysisPersistInput,
} from '../../../shared/src/index.js';

/**
 * Lambda handler for the Strategist Agent.
 *
 * @param event - Step Functions input with research results
 * @returns Trimmed context with full XML analysis for downstream stages
 */
export const handler = async (
    event: StrategistWriterHandlerInput,
): Promise<StrategistAnalysisPersistInput> => {
    console.log(
        `[strategist-writer-handler] Pipeline ${event.context.pipelineId} ` +
        `— generating analysis for "${event.context.targetRole}"`,
    );

    const analysis = await executeStrategistAgent(event.context, event.research.data);

    // ─── Payload trimming ─────────────────────────────────────────
    // Step Functions has a 256 KB payload limit between states.
    // After the Strategist Agent completes:
    //   • jobDescription — only used by Research + Strategist; not needed by
    //     Resume Builder or Persist handlers
    //
    // We replace it with a short sentinel to keep the chain payload
    // safely under the limit.
    // ──────────────────────────────────────────────────────────────

    const trimmedContext = {
        ...event.context,
        jobDescription: '[trimmed — persisted in METADATA]',
    };

    const payloadSize = JSON.stringify({ context: trimmedContext, research: event.research, analysis }).length;
    console.log(
        `[strategist-writer-handler] Output payload size: ${(payloadSize / 1024).toFixed(1)}KB ` +
        `(trimmed jobDescription: ${(event.context.jobDescription.length / 1024).toFixed(1)}KB saved)`,
    );

    return {
        context: trimmedContext,
        research: event.research,
        analysis,
    };
};

