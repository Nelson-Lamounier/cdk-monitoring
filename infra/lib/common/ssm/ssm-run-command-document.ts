/**
 * @format
 * SSM Run Command Document Construct
 *
 * Reusable construct for creating SSM Command documents.
 * Supports parameterized shell scripts that can be executed
 * via SSM Run Command against EC2 instances — without requiring
 * EC2 replacement or CDK stack redeployment.
 *
 * Can be used by any project (Monitoring, NextJS, etc.).
 *
 * @example
 * ```typescript
 * const doc = new SsmRunCommandDocument(this, 'ConfigureApp', {
 *     documentName: 'my-app-configure',
 *     description: 'Download and configure the application stack',
 *     parameters: {
 *         S3BucketName: { type: 'String', description: 'S3 bucket with app bundle' },
 *         Region: { type: 'String', default: 'eu-west-1' },
 *     },
 *     steps: [
 *         {
 *             name: 'downloadBundle',
 *             commands: [
 *                 'aws s3 sync s3://{{S3BucketName}}/scripts/ /opt/app/ --region {{Region}}',
 *             ],
 *         },
 *         {
 *             name: 'startServices',
 *             commands: ['cd /opt/app && docker compose up -d'],
 *         },
 *     ],
 * });
 * ```
 */

import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * SSM Document parameter definition.
 * Maps to SSM Document parameter schema.
 */
export interface SsmDocumentParameter {
    /** Parameter type */
    readonly type: 'String' | 'StringList' | 'Boolean' | 'Integer' | 'MapList';

    /** Human-readable description */
    readonly description?: string;

    /** Default value (parameter becomes optional when set) */
    readonly default?: string;

    /** Allowed values (enum constraint) */
    readonly allowedValues?: string[];
}

/**
 * A single step in the SSM Run Command document.
 * Each step executes a shell script on the target instance.
 */
export interface SsmRunCommandStep {
    /** Step name (unique within the document, alphanumeric + underscores) */
    readonly name: string;

    /** Shell commands to execute */
    readonly commands: string[];

    /**
     * Working directory for the commands
     * @default /tmp
     */
    readonly workingDirectory?: string;

    /**
     * Timeout in seconds for this step
     * @default 600
     */
    readonly timeoutSeconds?: number;
}

/**
 * Props for SsmRunCommandDocument
 */
export interface SsmRunCommandDocumentProps {
    /**
     * Document name. Must be unique within the account/region.
     * @example 'monitoring-development-configure-stack'
     */
    readonly documentName: string;

    /**
     * Human-readable description of the document's purpose.
     */
    readonly description?: string;

    /**
     * Parameterized inputs for the document.
     * Reference parameters in commands using {{ParameterName}} syntax.
     * @default {} (no parameters)
     */
    readonly parameters?: Record<string, SsmDocumentParameter>;

    /**
     * Ordered list of command steps to execute.
     * Steps run sequentially on the target instance.
     */
    readonly steps: SsmRunCommandStep[];

    /**
     * Tags to apply to the document.
     * @default []
     */
    readonly tags?: cdk.CfnTag[];
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Reusable SSM Run Command Document construct.
 *
 * Creates an `AWS::SSM::Document` of type `Command` that can be
 * executed against EC2 instances via `aws ssm send-command`.
 *
 * ## Why use this?
 *
 * Decouples application configuration from EC2 instance lifecycle:
 * - **User Data** = OS bootstrap (runs once at instance creation)
 * - **SSM Run Command** = App config (re-runnable without instance replacement)
 *
 * Changes to the SSM document require a stack update (document replacement),
 * but executing the document does NOT replace the EC2 instance.
 *
 * ## Usage pattern
 *
 * 1. Create the document in CDK (deploy once)
 * 2. Execute from CLI: `aws ssm send-command --document-name <name> --targets ...`
 * 3. Re-execute anytime config changes (no redeployment needed)
 *
 * @example
 * ```typescript
 * const configDoc = new SsmRunCommandDocument(this, 'ConfigureMonitoring', {
 *     documentName: `${namePrefix}-configure-stack`,
 *     description: 'Download monitoring stack from S3 and start services',
 *     parameters: {
 *         S3BucketName: { type: 'String', description: 'Scripts bucket' },
 *     },
 *     steps: [{
 *         name: 'configureStack',
 *         commands: ['aws s3 sync s3://{{S3BucketName}}/scripts/ /opt/monitoring/'],
 *     }],
 * });
 * ```
 */
export class SsmRunCommandDocument extends Construct {
    /** The underlying SSM CfnDocument resource */
    public readonly document: ssm.CfnDocument;

    /** The document name (used with aws ssm send-command) */
    public readonly documentName: string;

    constructor(scope: Construct, id: string, props: SsmRunCommandDocumentProps) {
        super(scope, id);

        this.documentName = props.documentName;

        // Build SSM document parameter schema
        const parameters: Record<string, unknown> = {};
        if (props.parameters) {
            for (const [key, param] of Object.entries(props.parameters)) {
                const paramDef: Record<string, unknown> = {
                    type: param.type,
                };
                if (param.description) paramDef.description = param.description;
                if (param.default !== undefined) paramDef.default = param.default;
                if (param.allowedValues) paramDef.allowedValues = param.allowedValues;
                parameters[key] = paramDef;
            }
        }

        // Build mainSteps array
        const mainSteps = props.steps.map((step) => ({
            action: 'aws:runShellScript',
            name: step.name,
            inputs: {
                runCommand: [
                    '#!/bin/bash',
                    'set -euxo pipefail',
                    '',
                    `echo "=== SSM Step: ${step.name} started at $(date) ==="`,
                    '',
                    ...step.commands,
                    '',
                    `echo "=== SSM Step: ${step.name} completed at $(date) ==="`,
                ],
                workingDirectory: step.workingDirectory ?? '/tmp',
                timeoutSeconds: String(step.timeoutSeconds ?? 600),
            },
        }));

        // Create the SSM Document
        this.document = new ssm.CfnDocument(this, 'Document', {
            documentType: 'Command',
            name: props.documentName,
            documentFormat: 'JSON',
            content: {
                schemaVersion: '2.2',
                description: props.description ?? `SSM Run Command: ${props.documentName}`,
                parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
                mainSteps,
            },
            tags: props.tags,
            updateMethod: 'NewVersion',
        });
    }
}
