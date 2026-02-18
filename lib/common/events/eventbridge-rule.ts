/**
 * @format
 * EventBridge Rule Construct
 *
 * Reusable EventBridge rule construct with Lambda integration.
 * Supports event patterns, schedules, and multiple targets.
 *
 * Features:
 * - Filter patterns for specific events
 * - Schedule expressions (cron/rate)
 * - Lambda function as target
 * - Dead letter queue support
 * - Input transformation
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Lambda target configuration
 */
export interface LambdaTargetConfig {
    /** The Lambda function to invoke */
    readonly function: lambda.IFunction;

    /** Event to use as input @default the matched event */
    readonly event?: events.RuleTargetInput;

    /** Dead letter queue for failed invocations */
    readonly deadLetterQueue?: sqs.IQueue;

    /** Maximum age of event to invoke target @default 24 hours */
    readonly maxEventAge?: cdk.Duration;

    /** Retry attempts on failed invocation @default 2 */
    readonly retryAttempts?: number;
}

/**
 * Props for EventBridgeRuleConstruct
 */
export interface EventBridgeRuleConstructProps {
    /** Rule name @default auto-generated */
    readonly ruleName?: string;

    /** Rule description */
    readonly description?: string;

    /**
     * Event pattern to match.
     * 
     * @example
     * {
     *   source: ['aws.autoscaling'],
     *   detailType: ['EC2 Instance Launch Successful'],
     * }
     */
    readonly eventPattern?: events.EventPattern;

    /**
     * Schedule for the rule (mutually exclusive with eventPattern for some use cases).
     * 
     * @example
     * events.Schedule.rate(cdk.Duration.minutes(5))
     * events.Schedule.cron({ minute: '0', hour: '12' })
     */
    readonly schedule?: events.Schedule;

    /** Lambda function targets */
    readonly lambdaTargets?: LambdaTargetConfig[];

    /** Custom event bus @default default event bus */
    readonly eventBus?: events.IEventBus;

    /** Whether the rule is enabled @default true */
    readonly enabled?: boolean;

    /** Name prefix for resources @default 'monitoring' */
    readonly namePrefix?: string;

    /** Cross-stack output of rule ARN @default false */
    readonly exportRuleArn?: boolean;
}

/**
 * Common event patterns for AWS services
 */
export class EventPatterns {
    /** EC2 Instance state change events */
    static ec2StateChange(states?: string[]): events.EventPattern {
        return {
            source: ['aws.ec2'],
            detailType: ['EC2 Instance State-change Notification'],
            ...(states ? { detail: { state: states } } : {}),
        };
    }

    /** Auto Scaling lifecycle events */
    static autoScalingLifecycle(events?: string[]): events.EventPattern {
        return {
            source: ['aws.autoscaling'],
            detailType: events ?? [
                'EC2 Instance Launch Successful',
                'EC2 Instance Terminate Successful',
                'EC2 Instance Launch Unsuccessful',
                'EC2 Instance Terminate Unsuccessful',
            ],
        };
    }

    /** CloudWatch Alarm state changes */
    static cloudWatchAlarm(alarmNames?: string[]): events.EventPattern {
        return {
            source: ['aws.cloudwatch'],
            detailType: ['CloudWatch Alarm State Change'],
            ...(alarmNames ? { resources: alarmNames.map(name => `arn:aws:cloudwatch:*:*:alarm:${name}`) } : {}),
        };
    }

    /** ECS Task state changes */
    static ecsTaskStateChange(): events.EventPattern {
        return {
            source: ['aws.ecs'],
            detailType: ['ECS Task State Change'],
        };
    }

    /** CodePipeline execution state changes */
    static codePipelineExecution(states?: string[]): events.EventPattern {
        return {
            source: ['aws.codepipeline'],
            detailType: ['CodePipeline Pipeline Execution State Change'],
            ...(states ? { detail: { state: states } } : {}),
        };
    }

    /** Custom application events */
    static custom(source: string, detailType: string, detail?: Record<string, unknown>): events.EventPattern {
        return {
            source: [source],
            detailType: [detailType],
            ...(detail ? { detail } : {}),
        };
    }
}

/**
 * Reusable EventBridge Rule construct for event-driven architectures
 *
 * @example
 * // ASG lifecycle events triggering Lambda
 * const rule = new EventBridgeRuleConstruct(this, 'AsgLifecycleRule', {
 *   ruleName: 'asg-lifecycle-events',
 *   eventPattern: EventPatterns.autoScalingLifecycle(),
 *   lambdaTargets: [{
 *     function: processorLambda.function,
 *   }],
 * });
 *
 * @example
 * // Scheduled Lambda invocation
 * const scheduledRule = new EventBridgeRuleConstruct(this, 'ScheduledRule', {
 *   ruleName: 'hourly-cleanup',
 *   schedule: events.Schedule.rate(Duration.hours(1)),
 *   lambdaTargets: [{
 *     function: cleanupLambda.function,
 *   }],
 * });
 */
export class EventBridgeRuleConstruct extends Construct {
    /** The EventBridge rule */
    public readonly rule: events.Rule;

    /** The event bus (if custom) */
    public readonly eventBus?: events.IEventBus;

    constructor(scope: Construct, id: string, props: EventBridgeRuleConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'monitoring';
        const ruleName = props.ruleName ?? `${namePrefix}-rule`;

        // Store event bus reference
        this.eventBus = props.eventBus;

        // Create the rule
        this.rule = new events.Rule(this, 'Rule', {
            ruleName,
            description: props.description ?? `${namePrefix} EventBridge rule`,
            eventBus: props.eventBus,
            eventPattern: props.eventPattern,
            schedule: props.schedule,
            enabled: props.enabled ?? true,
        });

        // Add Lambda targets
        if (props.lambdaTargets && props.lambdaTargets.length > 0) {
            props.lambdaTargets.forEach((targetConfig) => {
                const target = new targets.LambdaFunction(targetConfig.function, {
                    event: targetConfig.event,
                    deadLetterQueue: targetConfig.deadLetterQueue,
                    maxEventAge: targetConfig.maxEventAge ?? cdk.Duration.hours(24),
                    retryAttempts: targetConfig.retryAttempts ?? 2,
                });
                this.rule.addTarget(target);
            });
        }

        // Export rule ARN if requested
        if (props.exportRuleArn) {
            new cdk.CfnOutput(this, 'RuleArn', {
                value: this.rule.ruleArn,
                description: `ARN of ${ruleName} EventBridge rule`,
                exportName: `${ruleName}-arn`,
            });
        }

        // Apply tags
        cdk.Tags.of(this.rule).add('ManagedBy', 'CDK');
        cdk.Tags.of(this.rule).add('Component', 'EventBridge');
    }

    /**
     * Adds an additional Lambda target to the rule
     */
    addLambdaTarget(fn: lambda.IFunction, options?: Omit<LambdaTargetConfig, 'function'>): void {
        const target = new targets.LambdaFunction(fn, {
            event: options?.event,
            deadLetterQueue: options?.deadLetterQueue,
            maxEventAge: options?.maxEventAge ?? cdk.Duration.hours(24),
            retryAttempts: options?.retryAttempts ?? 2,
        });
        this.rule.addTarget(target);
    }

    /**
     * Returns the rule ARN
     */
    get ruleArn(): string {
        return this.rule.ruleArn;
    }

    /**
     * Returns the rule name
     */
    get ruleName(): string {
        return this.rule.ruleName;
    }
}
