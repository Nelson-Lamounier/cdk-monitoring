/**
 * @format
 * EIP Failover Construct — Hybrid-HA Guardian
 *
 * Reusable construct that automatically re-associates an Elastic IP
 * when an ASG instance is launched or terminated.
 *
 * Features:
 * - Python 3.13 Lambda triggered by EventBridge
 * - Handles both LAUNCH and TERMINATE ASG lifecycle events
 * - Tag-based instance discovery (works across all ASGs)
 * - Least-privilege IAM (EC2 address + instance describe)
 * - cdk-nag suppression for Python 3.13 runtime
 *
 * Design Philosophy:
 * - Construct is a blueprint, not a configuration handler
 * - Stack passes the EIP allocation ID and cluster tag
 * - Lambda handler lives in `lambda/eip-failover/index.py`
 *
 * Blueprint Pattern Flow:
 * 1. Stack resolves EIP allocation ID from SSM
 * 2. Stack creates EipFailoverConstruct with EIP + tag config
 * 3. EventBridge triggers Lambda on ASG instance lifecycle events
 *
 * Tag strategy:
 * Only `Component: EipFailover` is applied here. Organizational tags
 * (Environment, Project, Owner, ManagedBy) come from TaggingAspect at app level.
 *
 * @example
 * ```typescript
 * const eipFailover = new EipFailoverConstruct(this, 'EipFailover', {
 *     eipAllocationId: 'eipalloc-xxxx',
 *     clusterTagKey: 'kubernetes.io/cluster',
 *     clusterTagValue: 'monitoring-cluster',
 *     namePrefix: 'k8s-dev',
 * });
 * ```
 */

import * as path from 'path';

import { NagSuppressions } from 'cdk-nag';

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for EipFailoverConstruct
 */
export interface EipFailoverConstructProps {
    /**
     * The Elastic IP allocation ID to manage.
     * Resolved from SSM or passed directly.
     */
    readonly eipAllocationId: string;

    /** EC2 tag key used to discover cluster instances */
    readonly clusterTagKey: string;

    /** EC2 tag value used to discover cluster instances */
    readonly clusterTagValue: string;

    /**
     * Name prefix for resources.
     * Should be environment-aware (e.g., 'k8s-development') to prevent
     * collisions across environments in the same AWS account.
     * @default 'k8s'
     */
    readonly namePrefix?: string;

    /** Lambda timeout @default 30 seconds */
    readonly timeout?: cdk.Duration;

    /** Lambda memory size in MB @default 128 */
    readonly memorySize?: number;
}

/**
 * EIP Failover Construct — Hybrid-HA Guardian.
 *
 * Automatically re-associates the cluster EIP when an ASG instance is
 * launched or terminated. Uses tag-based instance discovery to find
 * healthy failover candidates across all ASGs.
 *
 * Creates:
 * - Lambda Function (Python 3.13, from asset)
 * - EventBridge Rule (ASG launch/terminate events)
 * - IAM Policy (EC2 address management + instance discovery)
 *
 * @example
 * ```typescript
 * const eipFailover = new EipFailoverConstruct(this, 'EipFailover', {
 *     eipAllocationId,
 *     clusterTagKey: MONITORING_APP_TAG.key,
 *     clusterTagValue: MONITORING_APP_TAG.value,
 *     namePrefix: 'k8s-dev',
 * });
 * ```
 */
export class EipFailoverConstruct extends Construct {
    /** The EIP failover Lambda function */
    public readonly function: lambda.Function;

    /** The EventBridge rule triggering the Lambda */
    public readonly rule: events.Rule;

    constructor(scope: Construct, id: string, props: EipFailoverConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'k8s';

        // =================================================================
        // LAMBDA FUNCTION
        // =================================================================
        this.function = new lambda.Function(this, 'Function', {
            functionName: `${namePrefix}-eip-failover`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(
                path.join(__dirname, '../../../../lambda/eip-failover'),
            ),
            timeout: props.timeout ?? cdk.Duration.seconds(30),
            memorySize: props.memorySize ?? 128,
            environment: {
                EIP_ALLOCATION_ID: props.eipAllocationId,
                CLUSTER_TAG_KEY: props.clusterTagKey,
                CLUSTER_TAG_VALUE: props.clusterTagValue,
            },
            description: 'Re-associates the K8s cluster EIP on ASG instance launch or terminate (Hybrid-HA)',
        });

        // =================================================================
        // IAM — least privilege for EIP management + instance discovery
        // =================================================================
        this.function.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EipFailoverPermissions',
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:DescribeAddresses',
                'ec2:AssociateAddress',
                'ec2:DisassociateAddress',
                'ec2:DescribeInstances',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // EVENTBRIDGE RULE
        //
        // Belt-and-suspenders: termination handles failover, launch handles
        // the race condition where minInstancesInService=0 causes the old
        // instance to terminate before the replacement is running.
        // =================================================================
        this.rule = new events.Rule(this, 'Rule', {
            ruleName: `${namePrefix}-eip-failover`,
            description: 'Trigger EIP failover on ASG instance terminate or launch',
            eventPattern: {
                source: ['aws.autoscaling'],
                detailType: [
                    'EC2 Instance Terminate Successful',
                    'EC2 Instance Launch Successful',
                ],
            },
            targets: [new targets.LambdaFunction(this.function)],
        });

        // =================================================================
        // CDK-NAG SUPPRESSION
        //
        // Python 3.13 is the latest GA Lambda runtime. CDK defines PYTHON_3_14
        // as a placeholder (not yet released), causing cdk-nag to flag 3.13.
        // =================================================================
        NagSuppressions.addResourceSuppressions(this.function, [{
            id: 'AwsSolutions-L1',
            reason: 'Python 3.13 is the latest GA Lambda runtime. PYTHON_3_14 is a CDK placeholder for an unreleased version.',
        }], true);

        // Tags: all 6 tags applied by TaggingAspect at stack level
    }
}
