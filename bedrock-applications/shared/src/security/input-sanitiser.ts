/**
 * @format
 * Input Sanitiser — Shared Security Module
 *
 * Provides a class-based input sanitiser that can be used directly
 * or extended by consumers with domain-specific patterns.
 *
 * Defence-in-depth: Pre-model input filtering reduces unnecessary
 * LLM invocations and associated costs. Bedrock Guardrails provide
 * an additional safety layer at the model level.
 *
 * ## Usage Modes
 *
 * **Simple block/pass** (chatbot-style):
 * ```typescript
 * import { InputSanitiser } from '@bedrock/shared';
 *
 * const sanitiser = new InputSanitiser();
 * const result = sanitiser.sanitise(userPrompt);
 * if (result.blocked) { /* reject * / }
 * ```
 *
 * **Extended with domain rules** (strategist-style):
 * ```typescript
 * const sanitiser = new InputSanitiser({
 *     minLength: 50,
 *     maxLength: 50_000,
 *     piiPatterns: STRATEGIST_PII_PATTERNS,
 * });
 * const result = sanitiser.sanitiseWithWarnings(rawJobDescription);
 * ```
 */

import type {
    InputPattern,
    PiiPattern,
    SanitiseInputResult,
    SanitisationResult,
} from './types.js';

// =============================================================================
// DEFAULT INJECTION PATTERNS (superset of all consumers)
// =============================================================================

/**
 * Core injection patterns shared across all Bedrock applications.
 *
 * This is the union of chatbot, strategist, and self-healing patterns.
 * Consumers may override via the constructor to narrow or extend the set.
 */
const DEFAULT_INJECTION_PATTERNS: ReadonlyArray<InputPattern> = [
    { pattern: /\bignore\s+(all\s+)?previous\s+instructions?\b/i, label: 'ignore-instructions' },
    { pattern: /\bsystem\s+prompt\b/i, label: 'system-prompt-probe' },
    { pattern: /\brepeat\s+(your|the)\s+instructions?\b/i, label: 'repeat-instructions' },
    { pattern: /\bjailbreak\b/i, label: 'jailbreak' },
    { pattern: /\bDAN\b/, label: 'dan-attack' },
    { pattern: /<script[\s>]/i, label: 'script-injection' },
    { pattern: /\0/, label: 'null-byte' },
    { pattern: /\bact\s+as\s+(if\s+)?you\s+(have\s+)?no\s+restrictions?\b/i, label: 'restriction-bypass' },
    { pattern: /\bpretend\s+(you\s+are|to\s+be)\b/i, label: 'persona-override' },
    { pattern: /you\s+are\s+now\s+a/gi, label: 'role-reassignment' },
    { pattern: /system\s*:\s*/gi, label: 'system-prompt-injection' },
    { pattern: /\[INST\]/gi, label: 'instruction-tag-injection' },
    { pattern: /<\|im_start\|>/gi, label: 'chat-marker-injection' },
    { pattern: /respond\s+as\s+if\s+you\s+have\s+no\s+restrictions/gi, label: 'respond-no-restrictions' },
];

// =============================================================================
// ERROR CLASS
// =============================================================================

/**
 * Error thrown when input fails sanitisation validation.
 *
 * Thrown by `sanitiseWithWarnings()` for length violations.
 */
export class InputSanitisationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InputSanitisationError';
    }
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configuration options for the InputSanitiser.
 *
 * All fields are optional — the sanitiser uses sensible defaults
 * when no configuration is provided.
 */
export interface InputSanitiserConfig {
    /** Custom injection patterns (overrides defaults if provided) */
    readonly injectionPatterns?: ReadonlyArray<InputPattern>;
    /** Additional injection patterns to append to the defaults */
    readonly extraInjectionPatterns?: ReadonlyArray<InputPattern>;
    /** PII patterns for warning-only detection */
    readonly piiPatterns?: ReadonlyArray<PiiPattern>;
    /** Minimum input length (used by `sanitiseWithWarnings` only) */
    readonly minLength?: number;
    /** Maximum input length (used by `sanitiseWithWarnings` only) */
    readonly maxLength?: number;
}

// =============================================================================
// INPUT SANITISER CLASS
// =============================================================================

/**
 * Configurable input sanitiser for pre-model prompt filtering.
 *
 * Provides two sanitisation modes:
 * - `sanitise()` — Simple block/pass (chatbot-style)
 * - `sanitiseWithWarnings()` — Comprehensive with length + PII + injection (strategist-style)
 *
 * Both modes share the same injection pattern set.
 */
export class InputSanitiser {
    private readonly injectionPatterns: ReadonlyArray<InputPattern>;
    private readonly piiPatterns: ReadonlyArray<PiiPattern>;
    private readonly minLength: number;
    private readonly maxLength: number;

    /**
     * Create a new InputSanitiser.
     *
     * @param config - Optional configuration for pattern sets and limits
     */
    constructor(config?: InputSanitiserConfig) {
        this.injectionPatterns = config?.injectionPatterns
            ?? [...DEFAULT_INJECTION_PATTERNS, ...(config?.extraInjectionPatterns ?? [])];
        this.piiPatterns = config?.piiPatterns ?? [];
        this.minLength = config?.minLength ?? 0;
        this.maxLength = config?.maxLength ?? Infinity;
    }

    /**
     * Simple block/pass sanitisation — for chatbot-style prompts.
     *
     * Normalises whitespace and checks against injection patterns.
     * Returns blocked status with the matched pattern label.
     *
     * @param raw - Raw user prompt text
     * @returns Sanitisation result with blocked status
     */
    sanitise(raw: string): SanitiseInputResult {
        const trimmed = raw.trim().replaceAll(/\s+/g, ' ');

        for (const { pattern, label } of this.injectionPatterns) {
            if (pattern.test(trimmed)) {
                return { sanitised: '', blocked: true, matchedPattern: label };
            }
        }

        return { sanitised: trimmed, blocked: false };
    }

    /**
     * Comprehensive sanitisation with length validation, injection
     * detection, and PII flagging — for strategist-style inputs.
     *
     * @param raw - Raw input text
     * @returns Sanitisation result with warnings and injection status
     * @throws InputSanitisationError if input fails length validation
     */
    sanitiseWithWarnings(raw: string): SanitisationResult {
        const warnings: string[] = [];

        // ── Step 1: Basic validation ─────────────────────────────
        if (!raw || raw.trim().length === 0) {
            throw new InputSanitisationError('Input cannot be empty');
        }

        if (this.minLength > 0 && raw.length < this.minLength) {
            throw new InputSanitisationError(
                `Input too short (${raw.length} chars, minimum ${this.minLength}). ` +
                'Please provide the full content.',
            );
        }

        if (this.maxLength < Infinity && raw.length > this.maxLength) {
            throw new InputSanitisationError(
                `Input too long (${raw.length} chars, maximum ${this.maxLength}). ` +
                'Please trim to the essential content.',
            );
        }

        // ── Step 2: Remove control characters ────────────────────
        // eslint-disable-next-line no-control-regex
        let sanitised = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

        // ── Step 3: Detect and neutralise injection attempts ─────
        let injectionDetected = false;
        for (const { pattern, label } of this.injectionPatterns) {
            if (pattern.test(sanitised)) {
                injectionDetected = true;
                warnings.push(`[security] Injection pattern detected: ${label}`);
                sanitised = sanitised.replace(pattern, '[REDACTED]');
            }
            // Reset lastIndex for global regexes
            if (pattern.global) {
                pattern.lastIndex = 0;
            }
        }

        // ── Step 4: Flag PII (warn, don't redact) ────────────────
        for (const { regex, label } of this.piiPatterns) {
            if (regex.test(sanitised)) {
                warnings.push(`[pii] Potential ${label} detected in input`);
            }
            if (regex.global) {
                regex.lastIndex = 0;
            }
        }

        return { sanitised, warnings, injectionDetected };
    }

    /**
     * Field-level sanitisation with max-length truncation — for
     * self-healing style event payload fields.
     *
     * Removes control characters, truncates to maxLength, and checks
     * for injection patterns.
     *
     * @param value - Raw field value
     * @param maxLength - Maximum allowed length
     * @returns Sanitised field value
     */
    sanitiseField(value: string, maxLength: number): string {
        // eslint-disable-next-line no-control-regex
        let sanitised = value.replaceAll(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

        if (sanitised.length > maxLength) {
            sanitised = sanitised.slice(0, maxLength) + '... [truncated]';
        }

        for (const { pattern } of this.injectionPatterns) {
            if (pattern.test(sanitised)) {
                sanitised = sanitised.replaceAll(pattern, '[REDACTED]');
            }
        }

        return sanitised;
    }
}
