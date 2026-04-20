/**
 * @format
 * Input Sanitiser — Deprecated Facade
 *
 * ⚠️  DEPRECATED: This module is a compatibility shim. All consumers
 * should import from `@bedrock/shared` (or `../../../shared/src/index.js`).
 *
 * Preserved temporarily for any transient imports during migration.
 * Will be removed in the next cleanup pass.
 */

import { InputSanitiser } from '../../../shared/src/index.js';
import type { SanitiseInputResult } from '../../../shared/src/index.js';

const _sanitiser = new InputSanitiser();

/**
 * @deprecated Use `new InputSanitiser().sanitise()` from `@bedrock/shared`.
 */
export function sanitiseInput(raw: string): SanitiseInputResult {
    return _sanitiser.sanitise(raw);
}

export type { SanitiseInputResult };
