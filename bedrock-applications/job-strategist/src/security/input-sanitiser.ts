/**
 * @format
 * Input Sanitiser — Security Layer 1
 *
 * Pre-model input filter that validates and sanitises the raw job
 * description before it reaches any Bedrock agent. Prevents prompt
 * injection, PII leakage, and malformed inputs.
 *
 * Separated from the handler following the gold-standard article pipeline
 * pattern where security concerns live in dedicated modules.
 *
 * @example
 * ```typescript
 * import { sanitiseInput, InputSanitisationError } from '../security/input-sanitiser.js';
 *
 * const { sanitised, warnings } = sanitiseInput(rawJobDescription);
 * if (warnings.length > 0) {
 *     console.warn('[security] Input warnings:', warnings);
 * }
 * ```
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Maximum allowed input length in characters */
const MAX_INPUT_LENGTH = 50_000;

/** Minimum meaningful job description length */
const MIN_INPUT_LENGTH = 50;

// =============================================================================
// INJECTION PATTERNS
// =============================================================================

/**
 * Patterns indicating prompt injection attempts.
 *
 * Each pattern is tested against the sanitised input. If matched,
 * the offending content is redacted and a warning is logged.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly label: string }> = [
    { regex: /ignore\s+(all\s+)?previous\s+instructions/gi, label: 'instruction-override' },
    { regex: /you\s+are\s+now\s+a/gi, label: 'role-reassignment' },
    { regex: /system\s*:\s*/gi, label: 'system-prompt-injection' },
    { regex: /\[INST\]/gi, label: 'instruction-tag-injection' },
    { regex: /<\|im_start\|>/gi, label: 'chat-marker-injection' },
    { regex: /\bDAN\b.*\bjailbreak/gi, label: 'jailbreak-attempt' },
    { regex: /respond\s+as\s+if\s+you\s+have\s+no\s+restrictions/gi, label: 'restriction-bypass' },
];

/**
 * Patterns indicating PII that should not be sent to the model.
 *
 * Job descriptions should not contain personal data; if they do,
 * it is flagged (not redacted, as JDs may legitimately reference
 * contact info for recruiters).
 */
const PII_PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly label: string }> = [
    { regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, label: 'phone-number' },
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: 'email-address' },
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, label: 'ssn-like-pattern' },
];

// =============================================================================
// ERROR CLASS
// =============================================================================

/**
 * Error thrown when input fails sanitisation validation.
 */
export class InputSanitisationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InputSanitisationError';
    }
}

// =============================================================================
// SANITISATION RESULT
// =============================================================================

/**
 * Result of input sanitisation.
 */
export interface SanitisationResult {
    /** Sanitised input text */
    readonly sanitised: string;
    /** Warning messages for flagged content */
    readonly warnings: string[];
    /** Whether any injection attempts were detected and neutralised */
    readonly injectionDetected: boolean;
}

// =============================================================================
// SANITISATION FUNCTION
// =============================================================================

/**
 * Sanitise raw job description input before passing to Bedrock agents.
 *
 * Performs:
 * 1. Length validation (MIN_INPUT_LENGTH–MAX_INPUT_LENGTH)
 * 2. Prompt injection detection and neutralisation
 * 3. PII flagging (warnings, not redaction)
 * 4. Control character removal
 *
 * @param raw - Raw job description text from user input
 * @returns Sanitised input with warnings
 * @throws InputSanitisationError if input is invalid
 */
export function sanitiseInput(raw: string): SanitisationResult {
    const warnings: string[] = [];

    // ── Step 1: Basic validation ─────────────────────────────
    if (!raw || raw.trim().length === 0) {
        throw new InputSanitisationError('Job description cannot be empty');
    }

    if (raw.length < MIN_INPUT_LENGTH) {
        throw new InputSanitisationError(
            `Job description too short (${raw.length} chars, minimum ${MIN_INPUT_LENGTH}). ` +
            'Please provide the full job listing.',
        );
    }

    if (raw.length > MAX_INPUT_LENGTH) {
        throw new InputSanitisationError(
            `Job description too long (${raw.length} chars, maximum ${MAX_INPUT_LENGTH}). ` +
            'Please trim to the essential requirements.',
        );
    }

    // ── Step 2: Remove control characters ────────────────────
    // eslint-disable-next-line no-control-regex
    let sanitised = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // ── Step 3: Detect and neutralise injection attempts ─────
    let injectionDetected = false;
    for (const { regex, label } of INJECTION_PATTERNS) {
        if (regex.test(sanitised)) {
            injectionDetected = true;
            warnings.push(`[security] Injection pattern detected: ${label}`);
            sanitised = sanitised.replace(regex, '[REDACTED]');
        }
        // Reset lastIndex for global regexes
        regex.lastIndex = 0;
    }

    // ── Step 4: Flag PII (warn, don't redact) ────────────────
    for (const { regex, label } of PII_PATTERNS) {
        if (regex.test(sanitised)) {
            warnings.push(`[pii] Potential ${label} detected in job description`);
        }
        regex.lastIndex = 0;
    }

    return { sanitised, warnings, injectionDetected };
}
