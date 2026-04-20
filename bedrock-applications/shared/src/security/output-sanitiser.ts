/**
 * @format
 * Output Sanitiser — Shared Security Module
 *
 * Provides a class-based output sanitiser that redacts sensitive
 * patterns from Bedrock agent responses. Prevents accidental
 * leakage of infrastructure identifiers, AWS resource ARNs,
 * IP addresses, credentials, and internal hostnames.
 *
 * ## Usage
 *
 * **Default patterns**:
 * ```typescript
 * import { OutputSanitiser } from '@bedrock/shared';
 *
 * const sanitiser = new OutputSanitiser();
 * const safe = sanitiser.sanitise(rawAgentResponse);
 * ```
 *
 * **Extended with domain-specific rules**:
 * ```typescript
 * const sanitiser = new OutputSanitiser({
 *     extraRules: [
 *         { regex: /dynamodb:.*?table\/[^\s,)}\]]+/g, replacement: '[DynamoDB Table]' },
 *     ],
 * });
 * ```
 */

import type { OutputRedactionRule } from './types.js';

// =============================================================================
// DEFAULT REDACTION PATTERNS (superset of all consumers)
// =============================================================================

/**
 * Core output redaction patterns shared across all Bedrock applications.
 *
 * Patterns are applied in order — more specific patterns (e.g. ARNs)
 * precede less specific ones (e.g. 12-digit numbers) to avoid
 * partial redaction artefacts.
 *
 * This is the union of chatbot and strategist patterns.
 */
const DEFAULT_REDACTION_RULES: ReadonlyArray<OutputRedactionRule> = [
    // AWS resource identifiers — most specific first
    { regex: /arn:aws:[a-zA-Z0-9-]+:[a-z0-9-]*:\d{12}:[^\s,)}\]]+/g, replacement: '[AWS Resource]' },
    { regex: /\b\d{12}\b/g, replacement: '[Account ID]' },
    { regex: /\b[A-Z0-9]{20}\b/g, replacement: '[Access Key]' },

    // Network identifiers
    { regex: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[^\s]*/g, replacement: '[Internal URL]' },
    { regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP Address]' },

    // Internal hostnames — catches Kubernetes cluster-internal service endpoints
    // (*.cluster.local), VPC-internal DNS (*.internal), and mDNS/link-local (*.local)
    { regex: /\b[a-z][a-z0-9-]{2,62}\.(internal|local|cluster\.local)\b/gi, replacement: '[Internal Host]' },

    // Credentials in key=value / key: value form
    { regex: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi, replacement: '[REDACTED]' },

    // Database identifiers
    { regex: /dynamodb:.*?table\/[^\s,)}\]]+/g, replacement: '[DynamoDB Table]' },

    // Third-party API keys
    { regex: /\bpc-[a-zA-Z0-9]{32,}\b/g, replacement: '[Pinecone Key]' },
];

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configuration options for the OutputSanitiser.
 */
export interface OutputSanitiserConfig {
    /** Custom redaction rules (overrides defaults if provided) */
    readonly rules?: ReadonlyArray<OutputRedactionRule>;
    /** Additional rules to append to the defaults */
    readonly extraRules?: ReadonlyArray<OutputRedactionRule>;
}

// =============================================================================
// OUTPUT SANITISER CLASS
// =============================================================================

/**
 * Configurable output sanitiser for post-model response filtering.
 *
 * Replaces sensitive patterns (ARNs, IPs, credentials, internal
 * hostnames) with descriptive placeholders. The end user receives
 * a useful, contextual answer without raw infrastructure identifiers.
 */
export class OutputSanitiser {
    private readonly rules: ReadonlyArray<OutputRedactionRule>;

    /**
     * Create a new OutputSanitiser.
     *
     * @param config - Optional configuration for redaction rules
     */
    constructor(config?: OutputSanitiserConfig) {
        this.rules = config?.rules
            ?? [...DEFAULT_REDACTION_RULES, ...(config?.extraRules ?? [])];
    }

    /**
     * Redact sensitive patterns from agent response text.
     *
     * Silently replaces infrastructure identifiers with descriptive
     * placeholders. Callers can compare the result to the input to
     * determine if any redaction occurred.
     *
     * @param raw - Raw agent response text
     * @returns Sanitised response with sensitive patterns redacted
     */
    sanitise(raw: string): string {
        let sanitised = raw;
        for (const { regex, replacement } of this.rules) {
            sanitised = sanitised.replace(regex, replacement);
        }
        return sanitised;
    }

    /**
     * Redact sensitive patterns and report whether redaction occurred.
     *
     * Useful for logging and metrics — callers can track redaction
     * frequency without comparing strings.
     *
     * @param raw - Raw agent response text
     * @returns Object with sanitised text and redaction flag
     */
    sanitiseWithReport(raw: string): { readonly sanitised: string; readonly wasRedacted: boolean } {
        const sanitised = this.sanitise(raw);
        return { sanitised, wasRedacted: sanitised !== raw };
    }
}
