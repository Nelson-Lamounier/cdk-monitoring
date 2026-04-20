/**
 * @format
 * Input Sanitiser — Deprecated Facade
 *
 * ⚠️  DEPRECATED: This module is a compatibility shim. All consumers
 * should import `InputSanitiser` from `@bedrock/shared`
 * (or `../../../shared/src/index.js`).
 *
 * Preserved temporarily for any transient imports during migration.
 * Will be removed in the next cleanup pass.
 */

import { InputSanitiser, InputSanitisationError } from '../../../shared/src/index.js';
import type { SanitisationResult, PiiPattern } from '../../../shared/src/index.js';

/**
 * PII patterns specific to job description inputs.
 */
const STRATEGIST_PII_PATTERNS: ReadonlyArray<PiiPattern> = [
    { regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, label: 'phone-number' },
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: 'email-address' },
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, label: 'ssn-like-pattern' },
];

const _sanitiser = new InputSanitiser({
    minLength: 50,
    maxLength: 50_000,
    piiPatterns: STRATEGIST_PII_PATTERNS,
});

/**
 * @deprecated Use `new InputSanitiser({ ... }).sanitiseWithWarnings()` from `@bedrock/shared`.
 */
export function sanitiseInput(raw: string): SanitisationResult {
    return _sanitiser.sanitiseWithWarnings(raw);
}

export { InputSanitisationError };
export type { SanitisationResult };
