/**
 * @format
 * Strategist Research Agent — Null-Safety Tests
 *
 * Reproduces the production crash:
 *   AgentExecutionError: Agent 'strategist-research' failed:
 *   Cannot read properties of undefined (reading '0')
 *
 * The crash occurs when the Bedrock KB query returns empty results,
 * causing the LLM to produce a response with missing nested objects
 * (e.g., technologyInventory). The parseResponse callback then
 * spreads the partial JSON, and downstream consumers access
 * nested properties without null-safety guards.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { parseJsonResponse } from '../../../shared/src/agent-runner';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

/** Simulates a COMPLETE LLM response with all fields present */
const COMPLETE_RESEARCH_JSON = JSON.stringify({
    targetRole: 'Senior DevOps Engineer',
    targetCompany: 'Acme Corp',
    seniority: 'senior',
    domain: 'cloud-infrastructure',
    overallFitRating: 'STRONG',
    fitSummary: 'Strong alignment between candidate and role.',
    hardRequirements: [{ skill: 'Kubernetes', context: 'Production K8s required', disqualifying: false }],
    softRequirements: [{ skill: 'Terraform', context: 'Nice to have' }],
    implicitRequirements: ['Team leadership'],
    verifiedMatches: [{
        skill: 'Kubernetes',
        depth: 'production',
        sourceCitation: 'portfolio/k8s-cluster',
        recency: '2026',
    }],
    partialMatches: [{
        skill: 'Terraform',
        gapDescription: 'Uses CDK instead',
        transferableFoundation: 'IaC expertise with CDK',
        framingSuggestion: 'Highlight CDK as modern IaC',
    }],
    gaps: [{ skill: 'Go', gapType: 'language', impactSeverity: 'low', disqualifyingAssessment: 'Not critical' }],
    technologyInventory: {
        languages: ['TypeScript', 'Python'],
        frameworks: ['CDK', 'Next.js'],
        infrastructure: ['AWS', 'Kubernetes'],
        tools: ['GitHub Actions', 'ArgoCD'],
        methodologies: ['GitOps', 'IaC'],
    },
    experienceSignals: {
        yearsExpected: '3-5',
        domainExperience: 'cloud-native',
        leadershipExpectation: 'team lead',
        scaleIndicators: 'startup to mid-size',
    },
});

/** Simulates an INCOMPLETE LLM response — missing technologyInventory and other nested objects */
const INCOMPLETE_RESEARCH_JSON = JSON.stringify({
    targetRole: 'DevOps Engineer',
    targetCompany: 'Unknown Corp',
    seniority: 'mid',
    domain: 'cloud',
    overallFitRating: 'STRETCH',
    fitSummary: 'Limited data for assessment.',
    hardRequirements: [],
    softRequirements: [],
    implicitRequirements: [],
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    // MISSING: technologyInventory — this is what causes the [0] crash
    // MISSING: experienceSignals
});

/** Simulates a MINIMAL LLM response — barely valid JSON */
const MINIMAL_RESEARCH_JSON = JSON.stringify({
    fitSummary: 'Insufficient data.',
    // Everything else is missing
});

/** Simulates LLM wrapping JSON in markdown code block */
const WRAPPED_RESEARCH_JSON = `Here is my analysis:

\`\`\`json
${INCOMPLETE_RESEARCH_JSON}
\`\`\`

I hope this helps.`;

// =============================================================================
// HELPER: Simulate parseResponse callback from research-agent.ts
// =============================================================================

/**
 * Reproduces the CURRENT (buggy) parseResponse callback.
 * This should crash on incomplete JSON.
 */
function buggyParseResponse(text: string): Record<string, unknown> {
    const parsed = parseJsonResponse<Record<string, unknown>>(text, 'strategist-research');

    return {
        ...parsed,
        hardRequirements: Array.isArray(parsed.hardRequirements) ? parsed.hardRequirements : [],
        softRequirements: Array.isArray(parsed.softRequirements) ? parsed.softRequirements : [],
        implicitRequirements: Array.isArray(parsed.implicitRequirements) ? parsed.implicitRequirements : [],
        verifiedMatches: Array.isArray(parsed.verifiedMatches) ? parsed.verifiedMatches : [],
        partialMatches: Array.isArray(parsed.partialMatches) ? parsed.partialMatches : [],
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
        // BUG: technologyInventory is NOT guarded — passes through as undefined via ...parsed
        // BUG: experienceSignals is NOT guarded
        // BUG: overallFitRating, targetRole, etc. not defaulted
        resumeData: null,
        kbContext: '',
    };
}

/**
 * Reproduces the downstream code in strategist-agent.ts that crashes.
 * This accesses `.technologyInventory.languages.join()` without null checks.
 */
function buggyBuildStrategistMessage(research: Record<string, any>): string {
    const sections: string[] = [
        '## Research Agent Brief',
        `Target Role: ${research.targetRole}`,
        `Fit Rating: ${research.overallFitRating}`,
        '',
    ];

    // THIS IS THE CRASH SITE — accessing nested property on undefined object
    sections.push(
        '', '### Technology Inventory',
        `Languages: ${research.technologyInventory.languages.join(', ')}`,
        `Frameworks: ${research.technologyInventory.frameworks.join(', ')}`,
        `Infrastructure: ${research.technologyInventory.infrastructure.join(', ')}`,
        `Tools: ${research.technologyInventory.tools.join(', ')}`,
        `Methodologies: ${research.technologyInventory.methodologies.join(', ')}`,
    );

    return sections.join('\n');
}

/**
 * FIXED parseResponse callback with null-safety guards.
 */
function fixedParseResponse(text: string): Record<string, unknown> {
    const parsed = parseJsonResponse<Record<string, unknown>>(text, 'strategist-research');

    return {
        ...parsed,
        hardRequirements: Array.isArray(parsed.hardRequirements) ? parsed.hardRequirements : [],
        softRequirements: Array.isArray(parsed.softRequirements) ? parsed.softRequirements : [],
        implicitRequirements: Array.isArray(parsed.implicitRequirements) ? parsed.implicitRequirements : [],
        verifiedMatches: Array.isArray(parsed.verifiedMatches) ? parsed.verifiedMatches : [],
        partialMatches: Array.isArray(parsed.partialMatches) ? parsed.partialMatches : [],
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
        technologyInventory: {
            languages: Array.isArray((parsed.technologyInventory as any)?.languages) ? (parsed.technologyInventory as any).languages : [],
            frameworks: Array.isArray((parsed.technologyInventory as any)?.frameworks) ? (parsed.technologyInventory as any).frameworks : [],
            infrastructure: Array.isArray((parsed.technologyInventory as any)?.infrastructure) ? (parsed.technologyInventory as any).infrastructure : [],
            tools: Array.isArray((parsed.technologyInventory as any)?.tools) ? (parsed.technologyInventory as any).tools : [],
            methodologies: Array.isArray((parsed.technologyInventory as any)?.methodologies) ? (parsed.technologyInventory as any).methodologies : [],
        },
        experienceSignals: {
            yearsExpected: (parsed.experienceSignals as any)?.yearsExpected ?? 'unspecified',
            domainExperience: (parsed.experienceSignals as any)?.domainExperience ?? 'unspecified',
            leadershipExpectation: (parsed.experienceSignals as any)?.leadershipExpectation ?? 'none specified',
            scaleIndicators: (parsed.experienceSignals as any)?.scaleIndicators ?? 'unspecified',
        },
        overallFitRating: (parsed.overallFitRating as string) ?? 'STRETCH',
        fitSummary: (parsed.fitSummary as string) ?? 'Analysis incomplete — insufficient data for assessment.',
        targetRole: (parsed.targetRole as string) ?? 'Unknown Role',
        targetCompany: (parsed.targetCompany as string) ?? 'Unknown Company',
        seniority: (parsed.seniority as string) ?? 'unspecified',
        domain: (parsed.domain as string) ?? 'unspecified',
        resumeData: null,
        kbContext: '',
    };
}

/**
 * FIXED downstream message builder with null-safety guards.
 */
function fixedBuildStrategistMessage(research: Record<string, any>): string {
    const sections: string[] = [
        '## Research Agent Brief',
        `Target Role: ${research.targetRole}`,
        `Fit Rating: ${research.overallFitRating}`,
        '',
    ];

    sections.push(
        '', '### Technology Inventory',
        `Languages: ${(research.technologyInventory?.languages ?? []).join(', ') || 'None specified'}`,
        `Frameworks: ${(research.technologyInventory?.frameworks ?? []).join(', ') || 'None specified'}`,
        `Infrastructure: ${(research.technologyInventory?.infrastructure ?? []).join(', ') || 'None specified'}`,
        `Tools: ${(research.technologyInventory?.tools ?? []).join(', ') || 'None specified'}`,
        `Methodologies: ${(research.technologyInventory?.methodologies ?? []).join(', ') || 'None specified'}`,
    );

    return sections.join('\n');
}

// =============================================================================
// TESTS
// =============================================================================

describe('parseJsonResponse', () => {
    it('should parse a complete JSON response correctly', () => {
        const result = parseJsonResponse<Record<string, unknown>>(COMPLETE_RESEARCH_JSON, 'test');
        expect(result.targetRole).toBe('Senior DevOps Engineer');
        expect(result.technologyInventory).toBeDefined();
    });

    it('should extract JSON from markdown-wrapped response', () => {
        const result = parseJsonResponse<Record<string, unknown>>(WRAPPED_RESEARCH_JSON, 'test');
        expect(result.targetRole).toBe('DevOps Engineer');
    });

    it('should throw on response with no JSON', () => {
        expect(() => parseJsonResponse('No JSON here', 'test')).toThrow('No JSON object found');
    });
});

describe('Strategist Research — Buggy parseResponse (current code)', () => {
    it('should succeed with complete LLM response', () => {
        const result = buggyParseResponse(COMPLETE_RESEARCH_JSON);
        expect(result.targetRole).toBe('Senior DevOps Engineer');
        expect(result.technologyInventory).toBeDefined();
    });

    it('should crash when technologyInventory is missing (REPRODUCES PRODUCTION BUG)', () => {
        // This reproduces the exact production crash:
        // Cannot read properties of undefined (reading '0')
        const result = buggyParseResponse(INCOMPLETE_RESEARCH_JSON);

        // The parseResponse itself succeeds — the bug is downstream
        expect(result.technologyInventory).toBeUndefined();

        // THIS crashes — reproducing the exact production error
        expect(() => buggyBuildStrategistMessage(result)).toThrow();
    });

    it('should crash on minimal JSON response', () => {
        const result = buggyParseResponse(MINIMAL_RESEARCH_JSON);
        expect(result.technologyInventory).toBeUndefined();
        expect(() => buggyBuildStrategistMessage(result)).toThrow();
    });
});

describe('Strategist Research — Fixed parseResponse (proposed fix)', () => {
    it('should succeed with complete LLM response', () => {
        const result = fixedParseResponse(COMPLETE_RESEARCH_JSON);
        expect(result.targetRole).toBe('Senior DevOps Engineer');
        expect(result.technologyInventory).toBeDefined();
    });

    it('should handle incomplete LLM response with safe defaults', () => {
        const result = fixedParseResponse(INCOMPLETE_RESEARCH_JSON);

        // technologyInventory should be present with empty arrays, not undefined
        expect(result.technologyInventory).toBeDefined();
        const techInv = result.technologyInventory as Record<string, string[]>;
        expect(techInv.languages).toEqual([]);
        expect(techInv.frameworks).toEqual([]);
        expect(techInv.infrastructure).toEqual([]);
        expect(techInv.tools).toEqual([]);
        expect(techInv.methodologies).toEqual([]);

        // experienceSignals should have defaults
        const expSig = result.experienceSignals as Record<string, string>;
        expect(expSig.yearsExpected).toBe('unspecified');
        expect(expSig.domainExperience).toBe('unspecified');
    });

    it('should handle minimal JSON without crashing', () => {
        const result = fixedParseResponse(MINIMAL_RESEARCH_JSON);
        expect(result.targetRole).toBe('Unknown Role');
        expect(result.targetCompany).toBe('Unknown Company');
        expect(result.overallFitRating).toBe('STRETCH');
    });

    it('should NOT crash downstream message builder after fix', () => {
        const result = fixedParseResponse(INCOMPLETE_RESEARCH_JSON);

        // This should NOT throw after the fix
        const message = fixedBuildStrategistMessage(result);
        expect(message).toContain('None specified');
        expect(message).toContain('Target Role: DevOps Engineer');
    });

    it('should NOT crash downstream message builder with minimal JSON', () => {
        const result = fixedParseResponse(MINIMAL_RESEARCH_JSON);
        const message = fixedBuildStrategistMessage(result);
        expect(message).toContain('None specified');
        expect(message).toContain('Unknown Role');
    });

    it('should handle markdown-wrapped response', () => {
        const result = fixedParseResponse(WRAPPED_RESEARCH_JSON);
        const techInv = result.technologyInventory as Record<string, string[]>;
        expect(techInv.languages).toEqual([]);  // Missing in the wrapped JSON too
    });
});
