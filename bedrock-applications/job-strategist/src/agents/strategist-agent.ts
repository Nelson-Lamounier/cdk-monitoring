/**
 * @format
 * Strategist Agent — 5-Phase Analysis & Document Generation
 *
 * Second agent in the 3-agent strategist pipeline. Receives the
 * Research Agent's structured brief and produces the full XML
 * analysis following the 5-phase framework (Phases 1–4).
 *
 * Uses Sonnet 4.6 for complex reasoning with extended thinking
 * enabled for document crafting.
 *
 * Pipeline position: API → Research → **Strategist** → Coach → DynamoDB
 */

import { runAgent } from '../../../shared/src/index.js';
import { STRATEGIST_PERSONA_SYSTEM_PROMPT } from '../prompts/strategist-persona.js';
import { sanitiseOutput } from '../security/output-sanitiser.js';
import type {
    AgentConfig,
    AgentResult,
    StrategistPipelineContext,
    StrategistResearchResult,
    StrategistAnalysisResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Strategist model — Sonnet 4.6 for complex reasoning */
const STRATEGIST_MODEL = process.env.STRATEGIST_MODEL ?? 'eu.anthropic.claude-sonnet-4-6-20250514-v1:0';

/** Maximum output tokens — large budget for full XML analysis */
const STRATEGIST_MAX_TOKENS = 16384;

/** Extended thinking budget for complex document crafting */
const STRATEGIST_THINKING_BUDGET = 12288;

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Strategist Agent.
 *
 * Formats the research brief as structured context for the
 * 5-phase analysis framework.
 *
 * @param research - Structured research result from the Research Agent
 * @param ctx - Pipeline context
 * @returns Formatted user message
 */
function buildStrategistMessage(
    research: StrategistResearchResult,
    ctx: StrategistPipelineContext,
): string {
    const sections: string[] = [
        '## Research Agent Brief',
        `Target Role: ${research.targetRole}`,
        `Target Company: ${research.targetCompany}`,
        `Seniority: ${research.seniority}`,
        `Domain: ${research.domain}`,
        `Overall Fit Rating: ${research.overallFitRating}`,
        `Fit Summary: ${research.fitSummary}`,
        '',
    ];

    // Hard requirements
    sections.push('### Hard Requirements');
    for (const req of research.hardRequirements) {
        sections.push(`- **${req.skill}**: ${req.context} ${req.disqualifying ? '⚠️ DISQUALIFYING' : ''}`);
    }

    sections.push('', '### Soft Requirements');
    for (const req of research.softRequirements) {
        sections.push(`- **${req.skill}**: ${req.context}`);
    }

    if (research.implicitRequirements.length > 0) {
        sections.push('', '### Implicit Requirements');
        for (const req of research.implicitRequirements) {
            sections.push(`- ${req}`);
        }
    }

    // Technology inventory
    sections.push(
        '', '### Technology Inventory',
        `Languages: ${research.technologyInventory.languages.join(', ')}`,
        `Frameworks: ${research.technologyInventory.frameworks.join(', ')}`,
        `Infrastructure: ${research.technologyInventory.infrastructure.join(', ')}`,
        `Tools: ${research.technologyInventory.tools.join(', ')}`,
        `Methodologies: ${research.technologyInventory.methodologies.join(', ')}`,
    );

    // Verified matches — batched push to satisfy lint
    const verifiedLines = research.verifiedMatches.map(
        (m) => `- **${m.skill}** [${m.depth}]: ${m.sourceCitation} (${m.recency})`,
    );
    sections.push('', '### Verified Matches (Evidence-Backed)', ...verifiedLines);

    // Partial matches
    sections.push('', '### Partial Matches (Transferable)');
    for (const partial of research.partialMatches) {
        sections.push(
            `- **${partial.skill}**: ${partial.gapDescription}`,
            `  Foundation: ${partial.transferableFoundation}`,
            `  Framing: ${partial.framingSuggestion}`,
        );
    }

    // Gaps
    sections.push('', '### Gaps');
    for (const gap of research.gaps) {
        sections.push(`- **${gap.skill}** [${gap.gapType}/${gap.impactSeverity}]: ${gap.disqualifyingAssessment}`);
    }

    // Resume data
    if (research.resumeData) {
        sections.push(
            '', '### Current Resume Content',
            '--- BEGIN RESUME ---',
            research.resumeData,
            '--- END RESUME ---',
        );
    }

    // Interview stage context and closing instruction
    sections.push(
        '', `### Current Interview Stage: ${ctx.interviewStage}`,
        '', 'Execute Phases 1–4 of the analysis framework and return the complete XML output.',
    );

    return sections.join('\n');
}

// =============================================================================
// XML METADATA EXTRACTION
// =============================================================================

/**
 * Extract key metadata fields from the XML analysis output.
 *
 * Uses simple regex extraction rather than a full XML parser to
 * avoid additional dependencies in the Lambda bundle.
 *
 * @param xml - Raw XML analysis output
 * @returns Extracted metadata fields
 */
function extractMetadataFromXml(xml: string): StrategistAnalysisResult['metadata'] {
    const extract = (tag: string): string => {
        const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
        const result = regex.exec(xml);
        return result?.[1]?.trim() ?? '';
    };

    return {
        candidateName: extract('candidate_name'),
        targetRole: extract('target_role'),
        targetCompany: extract('target_company'),
        analysisDate: extract('analysis_date'),
        overallFitRating: extract('overall_fit_rating') as StrategistAnalysisResult['metadata']['overallFitRating'],
        applicationRecommendation: extract('application_recommendation') as StrategistAnalysisResult['metadata']['applicationRecommendation'],
    };
}

/**
 * Extract the cover letter from the XML analysis.
 *
 * @param xml - Raw XML analysis output
 * @returns Cover letter text
 */
function extractCoverLetter(xml: string): string {
    const coverLetterRegex = /<cover_letter><!\[CDATA\[([\s\S]*?)\]\]><\/cover_letter>/;
    const result = coverLetterRegex.exec(xml);
    return result?.[1]?.trim() ?? '';
}

/**
 * Count specific XML elements in the analysis.
 *
 * @param xml - Raw XML analysis output
 * @param tag - XML tag to count
 * @returns Number of occurrences
 */
function countXmlElements(xml: string, tag: string): number {
    const regex = new RegExp(`<${tag}>`, 'g');
    let count = 0;
    while (regex.exec(xml) !== null) {
        count += 1;
    }
    return count;
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Strategist Agent.
 */
const STRATEGIST_CONFIG: AgentConfig = {
    agentName: 'strategist-writer',
    modelId: STRATEGIST_MODEL,
    maxTokens: STRATEGIST_MAX_TOKENS,
    thinkingBudget: STRATEGIST_THINKING_BUDGET,
    systemPrompt: STRATEGIST_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Strategist Agent.
 *
 * Receives the Research Agent's structured brief and produces
 * the full 5-phase XML analysis with document generation.
 *
 * @param ctx - Pipeline context
 * @param research - Research Agent's structured output
 * @returns Full XML analysis with metadata extraction
 */
export async function executeStrategistAgent(
    ctx: StrategistPipelineContext,
    research: StrategistResearchResult,
): Promise<AgentResult<StrategistAnalysisResult>> {
    console.log(
        `[strategist-writer] Pipeline ${ctx.pipelineId} — generating analysis for ` +
        `"${research.targetRole}" at "${research.targetCompany}"`,
    );

    const userMessage = buildStrategistMessage(research, ctx);

    const result = await runAgent<StrategistAnalysisResult>({
        config: STRATEGIST_CONFIG,
        userMessage,
        parseResponse: (text) => {
            // Sanitise output to redact any infrastructure identifiers
            const sanitisedXml = sanitiseOutput(text);

            // Extract metadata from XML for quick DynamoDB queries
            const metadata = extractMetadataFromXml(sanitisedXml);
            const coverLetter = extractCoverLetter(sanitisedXml);

            return {
                analysisXml: sanitisedXml,
                metadata,
                coverLetter,
                resumeAdditions: countXmlElements(sanitisedXml, 'addition'),
                resumeReframes: countXmlElements(sanitisedXml, 'reframe'),
                eslCorrections: countXmlElements(sanitisedXml, 'correction'),
            };
        },
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            slug: ctx.applicationSlug,
            sourceKey: '',
            bucket: ctx.bucket,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
            retryAttempt: 0,
            startedAt: ctx.startedAt,
        },
    });

    console.log(
        `[strategist-writer] Analysis generated — fit="${result.data.metadata.overallFitRating}", ` +
        `recommendation="${result.data.metadata.applicationRecommendation}", ` +
        `additions=${result.data.resumeAdditions}, reframes=${result.data.resumeReframes}, ` +
        `esl=${result.data.eslCorrections}`,
    );

    return result;
}
