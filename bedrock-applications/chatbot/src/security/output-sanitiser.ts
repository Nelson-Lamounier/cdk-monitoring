/**
 * @format
 * Output Sanitiser — Deprecated Facade
 *
 * ⚠️  DEPRECATED: This module is a compatibility shim. All consumers
 * should import from `@bedrock/shared` (or `../../../shared/src/index.js`).
 *
 * Preserved temporarily for any transient imports during migration.
 * Will be removed in the next cleanup pass.
 */

import { OutputSanitiser } from '../../../shared/src/index.js';

const _sanitiser = new OutputSanitiser();

/**
 * @deprecated Use `new OutputSanitiser().sanitise()` from `@bedrock/shared`.
 */
export function sanitiseOutput(raw: string): string {
    return _sanitiser.sanitise(raw);
}
