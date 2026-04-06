/**
 * @format
 * Strategist Data Stack — DynamoDB Table for Job Applications
 *
 * Stateful resources for the Job Strategist pipeline.
 * Owns the DynamoDB table that stores job application analyses,
 * interview coaching sessions, and pipeline execution history.
 *
 * Entity schema:
 *   pk: JOB#<jobId>
 *   sk: METADATA       — job description, company, target role
 *   sk: RESEARCH#<ts>   — research agent output (gap analysis, match report)
 *   sk: STRATEGY#<ts>   — strategist agent XML analysis
 *   sk: COACH#<stage>#<ts> — interview coaching per stage
 *   sk: STATUS          — pipeline execution status tracking
 *
 * GSI: gsi1-status-date
 *   gsi1pk: STATUS#<status>  → groups applications by status
 *   gsi1sk: <date>#<jobId>   → reverse-chronological listing
 *
 * Lifecycle: independent of pipeline Lambda redeployments.
 * Data persists across agent upgrades.
 */

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for StrategistDataStack.
 */
export interface StrategistDataStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Name of the shared S3 assets bucket (from BedrockDataStack) */
    readonly assetsBucketName: string;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Runtime environment name (e.g. 'development') */
    readonly environmentName: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Strategist Data Stack — DynamoDB Table for Job Applications.
 *
 * Creates:
 * - DynamoDB table for job application metadata and pipeline outputs
 * - SSM parameter exports for cross-stack consumption
 * - Grant helper for consumer applications (admin dashboard on K8s)
 */
export class StrategistDataStack extends cdk.Stack {
    /** DynamoDB table for job strategist data */
    public readonly strategistTable: dynamodb.TableV2;

    /** Table name (for cross-stack consumption) */
    public readonly tableName: string;

    constructor(scope: Construct, id: string, props: StrategistDataStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // DynamoDB — Strategist Table
        //
        // pk: JOB#<jobId>
        // sk: METADATA | RESEARCH#<ts> | STRATEGY#<ts> | COACH#<stage>#<ts> | STATUS
        //
        // GSI: gsi1-status-date
        //   gsi1pk: STATUS#<status>  (e.g. STATUS#analysed, STATUS#interview_active)
        //   gsi1sk: <date>#<jobId>   (e.g. 2026-03-30#abc123)
        //   Query: all applications by status, newest first (admin listing)
        // =================================================================
        this.strategistTable = new dynamodb.TableV2(this, 'StrategistTable', {
            tableName: `${namePrefix}-job-strategist`,
            partitionKey: {
                name: 'pk',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'sk',
                type: dynamodb.AttributeType.STRING,
            },
            billing: dynamodb.Billing.onDemand(),
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
            removalPolicy: props.removalPolicy,
            globalSecondaryIndexes: [
                {
                    indexName: 'gsi1-status-date',
                    partitionKey: {
                        name: 'gsi1pk',
                        type: dynamodb.AttributeType.STRING,
                    },
                    sortKey: {
                        name: 'gsi1sk',
                        type: dynamodb.AttributeType.STRING,
                    },
                    // ALL projection — admin listing needs title, company,
                    // status, analysis summary without separate GetItem calls
                },
            ],
        });
        this.tableName = this.strategistTable.tableName;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'StrategistTableNameParam', {
            parameterName: `/${namePrefix}/strategist-table-name`,
            stringValue: this.strategistTable.tableName,
            description: `Job Strategist table name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'StrategistTableArnParam', {
            parameterName: `/${namePrefix}/strategist-table-arn`,
            stringValue: this.strategistTable.tableArn,
            description: `Job Strategist table ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'StrategistTableName', {
            value: this.strategistTable.tableName,
            description: 'Job Strategist DynamoDB table name',
        });

        new cdk.CfnOutput(this, 'StrategistTableArn', {
            value: this.strategistTable.tableArn,
            description: 'Job Strategist DynamoDB table ARN',
        });
    }

    // =====================================================================
    // PUBLIC GRANT HELPERS
    // =====================================================================

    /**
     * Grant read access to strategist data for a consuming application.
     *
     * Grants DynamoDB read (GetItem, Query, Scan) on the strategist table.
     * Use when the Next.js admin dashboard on K8s needs to display
     * job application analyses and coaching sessions.
     *
     * @param grantee - The IAM principal to grant read access to
     *
     * @example
     * ```typescript
     * strategistDataStack.grantStrategistRead(k8sWorkerRole);
     * ```
     */
    public grantStrategistRead(grantee: iam.IGrantable): void {
        this.strategistTable.grantReadData(grantee);
    }
}
