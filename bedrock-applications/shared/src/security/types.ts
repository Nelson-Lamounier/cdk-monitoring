/**
 * @format
 * Security Types — Shared Sanitisation Contracts
 *
 * Defines the type contracts used by both input and output sanitisers
 * across all Bedrock application modules. Consumers import these types
 * from `@bedrock/shared` rather than defining local copies.
 */

// =============================================================================
// PATTERN TYPES
// =============================================================================

/**
 * A labelled regex pattern used for input injection detection.
 *
 * @property pattern - The regex to test against input text
 * @property label - Human-readable label for audit logging (e.g. 'jailbreak')
 */
export interface InputPattern {
    readonly pattern: RegExp;
    readonly label: string;
}

/**
 * A regex-to-replacement mapping used for output redaction.
 *
 * @property regex - The regex to match sensitive content
 * @property replacement - The placeholder text (e.g. '[AWS Resource]')
 */
export interface OutputRedactionRule {
    readonly regex: RegExp;
    readonly replacement: string;
}

/**
 * A regex-to-label mapping used for PII detection (warn, don't redact).
 *
 * @property regex - The regex to detect PII patterns
 * @property label - Human-readable label for warning messages
 */
export interface PiiPattern {
    readonly regex: RegExp;
    readonly label: string;
}

// =============================================================================
// INPUT SANITISATION RESULTS
// =============================================================================

/**
 * Result of a simple blocked-or-pass input sanitisation check.
 *
 * Used by consumers that only need binary block/pass decisions
 * (e.g. chatbot prompt guard).
 *
 * @property sanitised - The normalised prompt text (empty if blocked)
 * @property blocked - Whether the input was blocked by a pattern match
 * @property matchedPattern - The label of the matched pattern, if blocked
 */
export interface SanitiseInputResult {
    /** The sanitised (trimmed, normalised) prompt text */
    readonly sanitised: string;
    /** Whether the input was blocked by a pattern match */
    readonly blocked: boolean;
    /** The label of the matched pattern, if blocked */
    readonly matchedPattern?: string;
}

/**
 * Result of a comprehensive input sanitisation with warnings.
 *
 * Used by consumers that need detailed feedback on detected issues
 * (e.g. job strategist with PII flagging).
 *
 * @property sanitised - Sanitised input text
 * @property warnings - Warning messages for flagged content
 * @property injectionDetected - Whether any injection attempts were neutralised
 */
export interface SanitisationResult {
    /** Sanitised input text */
    readonly sanitised: string;
    /** Warning messages for flagged content */
    readonly warnings: string[];
    /** Whether any injection attempts were detected and neutralised */
    readonly injectionDetected: boolean;
}
