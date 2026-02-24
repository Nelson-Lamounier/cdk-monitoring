/**
 * @format
 * Validation Utilities
 *
 * Input validation helpers for CDK constructs and stacks.
 */

/**
 * CIDR validation result
 */
export interface ValidationResult {
    readonly valid: boolean;
    readonly error?: string;
}

/**
 * Validate CIDR block format
 */
export function validateCidr(cidr: string): ValidationResult {
    const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
    if (!cidrRegex.test(cidr)) {
        return {
            valid: false,
            error: `Invalid CIDR format: ${cidr}. Expected format: x.x.x.x/y`,
        };
    }

    // Validate IP octets
    const parts = cidr.split('/');
    const octets = parts[0].split('.').map(Number);
    for (const octet of octets) {
        if (octet < 0 || octet > 255) {
            return {
                valid: false,
                error: `Invalid IP octet in CIDR: ${cidr}`,
            };
        }
    }

    // Validate prefix
    const prefix = parseInt(parts[1], 10);
    if (prefix < 0 || prefix > 32) {
        return {
            valid: false,
            error: `Invalid prefix length in CIDR: ${cidr}. Must be 0-32`,
        };
    }

    return { valid: true };
}

/**
 * Validate multiple CIDRs, throws on first invalid
 */
export function validateCidrs(cidrs: string[]): void {
    if (cidrs.length === 0) {
        throw new Error('At least one CIDR must be provided');
    }

    for (const cidr of cidrs) {
        const result = validateCidr(cidr);
        if (!result.valid) {
            throw new Error(result.error);
        }
    }
}

/**
 * Validate GP3 volume configuration
 */
export function validateGp3Volume(iops?: number, throughput?: number): ValidationResult {
    if (iops !== undefined) {
        if (iops < 3000 || iops > 16000) {
            return {
                valid: false,
                error: 'GP3 IOPS must be between 3000 and 16000',
            };
        }
    }

    if (throughput !== undefined) {
        if (throughput < 125 || throughput > 1000) {
            return {
                valid: false,
                error: 'GP3 throughput must be between 125 and 1000 MiB/s',
            };
        }
    }

    return { valid: true };
}

/**
 * Validate port number
 */
export function validatePort(port: number): ValidationResult {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return {
            valid: false,
            error: `Invalid port number: ${port}. Must be 1-65535`,
        };
    }
    return { valid: true };
}
