/**
 * @format
 * Input Sanitiser — Security Layer 2
 *
 * Pre-model input guard that sanitises and validates user prompts
 * against known injection patterns. Defence-in-depth: Bedrock Guardrail
 * also catches PROMPT_ATTACK at HIGH strength, but pre-model filtering
 * reduces unnecessary LLM invocations and associated costs.
 *
 * Separated from the handler following the gold-standard article pipeline
 * pattern where security concerns live in dedicated modules.
 *
 * @example
 * ```typescript
 * import { sanitiseInput } from '../security/input-sanitiser.js';
 *
 * const result = sanitiseInput(body.prompt);
 * if (result.blocked) {
 *     // return friendly message — do NOT reveal "blocked"
 * }
 * ```
 */

import type { SanitiseInputResult } from '../types.js';

// =============================================================================
// BLOCKED PATTERNS
// =============================================================================

/**
 * Patterns that indicate prompt injection or abuse attempts.
 * These are blocked before the prompt reaches the Bedrock Agent.
 *
 * Each pattern includes a human-readable label for audit logging,
 * allowing security teams to track attack vectors without exposing
 * pattern details to the client.
 */
const BLOCKED_INPUT_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
    { pattern: /\bignore\s+(all\s+)?previous\s+instructions?\b/i, label: 'ignore-instructions' },
    { pattern: /\bsystem\s+prompt\b/i, label: 'system-prompt-probe' },
    { pattern: /\brepeat\s+(your|the)\s+instructions?\b/i, label: 'repeat-instructions' },
    { pattern: /\bjailbreak\b/i, label: 'jailbreak' },
    { pattern: /\bDAN\b/, label: 'dan-attack' },
    { pattern: /<script[\s>]/i, label: 'script-injection' },
    { pattern: /\0/, label: 'null-byte' },
    { pattern: /\bact\s+as\s+(if\s+)?you\s+(have\s+)?no\s+restrictions?\b/i, label: 'restriction-bypass' },
    { pattern: /\bpretend\s+(you\s+are|to\s+be)\b/i, label: 'persona-override' },
];

// =============================================================================
// SANITISATION FUNCTION
// =============================================================================

/**
 * Sanitise and validate user input against injection patterns.
 *
 * Normalises whitespace and checks against known attack patterns.
 * Returns the sanitised text or a blocked indicator with the matched
 * pattern label for audit logging.
 *
 * @param raw - Raw user prompt text
 * @returns Sanitisation result with blocked status and matched pattern
 */
export function sanitiseInput(raw: string): SanitiseInputResult {
    const trimmed = raw.trim().replaceAll(/\s+/g, ' ');

    for (const { pattern, label } of BLOCKED_INPUT_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { sanitised: '', blocked: true, matchedPattern: label };
        }
    }

    return { sanitised: trimmed, blocked: false };
}
