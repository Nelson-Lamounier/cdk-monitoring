/**
 * @format
 * Output Sanitiser — Security Layer 5
 *
 * Post-model output filter that redacts sensitive patterns from
 * strategist agent responses. Prevents accidental leakage of
 * infrastructure identifiers, AWS resource ARNs, IP addresses,
 * and credentials in the analysis output.
 *
 * Mirrors the chatbot output-sanitiser pattern but includes
 * additional patterns specific to career strategy context.
 *
 * @example
 * ```typescript
 * import { sanitiseOutput } from '../security/output-sanitiser.js';
 *
 * const sanitised = sanitiseOutput(rawAnalysisXml);
 * const wasRedacted = sanitised !== rawAnalysisXml;
 * ```
 */

// =============================================================================
// REDACTION PATTERNS
// =============================================================================

/**
 * Patterns to redact from agent responses.
 *
 * Each entry maps a regex to a descriptive placeholder. Patterns
 * are applied in order — more specific patterns precede less
 * specific ones to avoid partial redaction artefacts.
 */
const SENSITIVE_OUTPUT_PATTERNS: ReadonlyArray<{
    readonly regex: RegExp;
    readonly replacement: string;
}> = [
    // AWS infrastructure identifiers
    { regex: /arn:aws:[a-zA-Z0-9-]+:[a-z0-9-]*:\d{12}:[^\s,)}\]]+/g, replacement: '[AWS Resource]' },
    { regex: /\b\d{12}\b/g, replacement: '[Account ID]' },
    { regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP Address]' },
    { regex: /\b[A-Z0-9]{20}\b/g, replacement: '[Access Key]' },
    { regex: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi, replacement: '[REDACTED]' },
    { regex: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[^\s]*/g, replacement: '[Internal URL]' },

    // Database identifiers that could leak
    { regex: /dynamodb:.*?table\/[^\s,)}\]]+/g, replacement: '[DynamoDB Table]' },

    // Pinecone API keys (pc-xxxx format)
    { regex: /\bpc-[a-zA-Z0-9]{32,}\b/g, replacement: '[Pinecone Key]' },
];

// =============================================================================
// SANITISATION FUNCTION
// =============================================================================

/**
 * Redact sensitive patterns from agent response text.
 *
 * Silently replaces infrastructure identifiers with descriptive
 * placeholders. The admin user receives the full analysis without
 * raw technical identifiers that could be exposed.
 *
 * @param raw - Raw agent response text
 * @returns Sanitised response with sensitive patterns redacted
 */
export function sanitiseOutput(raw: string): string {
    let sanitised = raw;
    for (const { regex, replacement } of SENSITIVE_OUTPUT_PATTERNS) {
        sanitised = sanitised.replace(regex, replacement);
    }
    return sanitised;
}
