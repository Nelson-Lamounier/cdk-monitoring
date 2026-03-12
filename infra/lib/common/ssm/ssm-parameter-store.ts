/**
 * @format
 * SSM Parameter Store Construct (L3)
 *
 * Dynamic, reusable construct that creates a batch of SSM String Parameters
 * from a simple name→value record. Uses a for loop to iterate over entries
 * and auto-generates construct IDs and descriptions from the path.
 *
 * @example
 * ```typescript
 * // Simple: Record<string, string> — descriptions auto-generated from path
 * new SsmParameterStoreConstruct(this, 'SsmParams', {
 *     parameters: {
 *         '/k8s/dev/vpc-id':     vpc.vpcId,
 *         '/k8s/dev/elastic-ip': eip.ref,
 *     },
 * });
 * ```
 */

import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for {@link SsmParameterStoreConstruct}.
 */
export interface SsmParameterStoreConstructProps {
    /**
     * SSM parameter name → value record.
     *
     * Each entry produces one `ssm.StringParameter` resource:
     * - Construct ID: auto-generated from the last path segment in PascalCase
     * - Description: auto-generated from the last path segment in Title Case
     * - Tier: STANDARD (override per-parameter via `tierOverrides`)
     *
     * @example
     * ```typescript
     * parameters: {
     *     [ssmPaths.vpcId]: vpc.vpcId,
     *     [ssmPaths.elasticIp]: eip.ref,
     * }
     * ```
     */
    readonly parameters: Record<string, string>;

    /**
     * Optional tier overrides for specific parameter paths.
     * Use `ADVANCED` tier for values > 4 KB.
     *
     * @default all parameters use STANDARD tier
     */
    readonly tierOverrides?: Record<string, ssm.ParameterTier>;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * L3 construct that batch-creates SSM String Parameters from a name→value record.
 *
 * Benefits over inline `new ssm.StringParameter()` calls:
 * - **Declarative**: define parameters as a flat Record — no boilerplate
 * - **Consistent**: construct IDs and descriptions auto-generated from path
 * - **Dynamic**: adding a parameter = adding one line to the record
 * - **Reusable**: any stack can use this construct
 *
 * The construct exposes the created parameters via `parameterMap` for
 * cases where downstream code needs a reference (e.g., grant read access).
 */
export class SsmParameterStoreConstruct extends Construct {
    /** Map of parameter name → created `ssm.StringParameter` */
    public readonly parameterMap: ReadonlyMap<string, ssm.StringParameter>;

    constructor(
        scope: Construct,
        id: string,
        props: SsmParameterStoreConstructProps,
    ) {
        super(scope, id);

        const map = new Map<string, ssm.StringParameter>();

        for (const [parameterName, stringValue] of Object.entries(props.parameters)) {
            const constructId = SsmParameterStoreConstruct._toConstructId(parameterName);
            const description = SsmParameterStoreConstruct._toDescription(parameterName);
            const tier = props.tierOverrides?.[parameterName] ?? ssm.ParameterTier.STANDARD;

            const param = new ssm.StringParameter(this, constructId, {
                parameterName,
                stringValue,
                description,
                tier,
            });

            map.set(parameterName, param);
        }

        this.parameterMap = map;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Convert an SSM parameter path into a unique PascalCase construct ID.
     *
     * Examples:
     * - `/k8s/development/vpc-id`          → `VpcIdParam`
     * - `/k8s/development/elastic-ip`      → `ElasticIpParam`
     * - `/k8s/development/kms-key-arn`     → `KmsKeyArnParam`
     */
    private static _toConstructId(parameterName: string): string {
        const lastSegment = parameterName.split('/').pop() ?? parameterName;
        const pascal = lastSegment
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
        return `${pascal}Param`;
    }

    /**
     * Convert an SSM parameter path into a human-readable description.
     *
     * Extracts the last path segment and converts it to Title Case.
     *
     * Examples:
     * - `/k8s/development/vpc-id`              → `Vpc Id`
     * - `/k8s/development/elastic-ip`           → `Elastic Ip`
     * - `/k8s/development/kms-key-arn`          → `Kms Key Arn`
     * - `/k8s/development/control-plane-sg-id`  → `Control Plane Sg Id`
     */
    private static _toDescription(parameterName: string): string {
        const lastSegment = parameterName.split('/').pop() ?? parameterName;
        return lastSegment
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }
}
