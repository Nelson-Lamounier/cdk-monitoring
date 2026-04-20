/**
 * @format
 * Security Module — Barrel Export
 *
 * Public API for the shared security module. All consumers should
 * import from this barrel rather than from individual files.
 *
 * @example
 * ```typescript
 * import { InputSanitiser, OutputSanitiser } from '@bedrock/shared/security';
 * ```
 */

export { InputSanitiser, InputSanitisationError } from './input-sanitiser.js';
export type { InputSanitiserConfig } from './input-sanitiser.js';
export { OutputSanitiser } from './output-sanitiser.js';
export type { OutputSanitiserConfig } from './output-sanitiser.js';
export type {
    InputPattern,
    OutputRedactionRule,
    PiiPattern,
    SanitiseInputResult,
    SanitisationResult,
} from './types.js';
