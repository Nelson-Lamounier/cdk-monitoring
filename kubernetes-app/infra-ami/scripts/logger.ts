/**
 * @format
 * Logger — Lightweight logger for infra-ami scripts
 *
 * Minimal console logger without external dependencies.
 * Mirrors the interface of infra/scripts/deployment/logger.ts
 * but uses plain console output (no chalk dependency).
 */

const logger = {
    info: (message: string): void => {
        console.log(`ℹ ${message}`);
    },

    warn: (message: string): void => {
        console.warn(`⚠ ${message}`);
    },

    error: (message: string): void => {
        console.error(`✗ ${message}`);
    },

    success: (message: string): void => {
        console.log(`✓ ${message}`);
    },

    debug: (message: string): void => {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`⊡ ${message}`);
        }
    },
};

export default logger;
