/**
 * @format
 * Shared Project Factory
 *
 * Creates shared infrastructure (VPC, Security Baseline) used by multiple
 * projects. This project should be deployed first before other projects.
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment, cdkEnvironment } from '../../config/environments';
import { Project, getProjectConfig } from '../../config/projects';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import { SharedVpcStack } from '../../shared/vpc-stack';
import { SecurityBaselineStack } from '../../stacks/shared/security-baseline-stack';
import { stackId, flatName } from '../../utilities/naming';

/**
 * Factory context for Shared project.
 */
export interface SharedFactoryContext extends ProjectFactoryContext {
    /** Optional notification email for security findings */
    readonly notificationEmail?: string;

    /** Enable GuardDuty @default true */
    readonly enableGuardDuty?: boolean;

    /** Enable Security Hub @default true */
    readonly enableSecurityHub?: boolean;

    /** Enable IAM Access Analyzer @default true */
    readonly enableAccessAnalyzer?: boolean;
}

/**
 * Factory for creating shared infrastructure resources.
 *
 * Creates:
 * - VPC stack with public subnets, SSM exports, and flow logs
 * - Security baseline stack (GuardDuty, Security Hub, Access Analyzer)
 *
 * @example
 * ```typescript
 * const factory = new SharedProjectFactory(Environment.DEVELOPMENT);
 * const result = factory.createAllStacks(app, context);
 * ```
 */
export class SharedProjectFactory implements IProjectFactory<SharedFactoryContext> {
    public readonly project = Project.SHARED;
    public readonly environment: Environment;
    public readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.SHARED).namespace;
    }

    createAllStacks(scope: cdk.App, context: SharedFactoryContext): ProjectStackFamily {
        const env = context.environment;
        const stacks: cdk.Stack[] = [];
        const stackMap: Record<string, cdk.Stack> = {};

        const namePrefix = flatName('shared', '', env);

        cdk.Annotations.of(scope).addInfo(`Creating Shared infrastructure for ${env}`);

        // =================================================================
        // Stack 1: Infrastructure — VPC + ECR shared by all projects
        // =================================================================
        const infraStackName = stackId(this.namespace, 'Infra', env);
        const infraStack = new SharedVpcStack(scope, infraStackName, {
            targetEnvironment: env,
            flowLogConfig: {
                logGroupName: `/vpc/${this.namespace.toLowerCase()}/${env}/flow-logs`,
                createEncryptionKey: env !== Environment.DEVELOPMENT,
            },
            env: cdkEnvironment(this.environment),
        });

        stacks.push(infraStack);
        stackMap['infra'] = infraStack;

        // =================================================================
        // Stack 2: Security Baseline — GuardDuty + Security Hub + Access Analyzer
        //
        // Deployed once per account/region. Minimal-cost defaults:
        //   - GuardDuty: core detection only (no S3/EKS/Malware extras)
        //   - Security Hub: auto-enabled controls, no default standards
        //   - IAM Access Analyzer: account scope (free)
        //
        // Cost: ~$3–8/month for a small account.
        // =================================================================
        const securityStackName = stackId(this.namespace, 'SecurityBaseline', env);
        const securityStack = new SecurityBaselineStack(scope, securityStackName, {
            targetEnvironment: env,
            namePrefix,
            notificationEmail: context.notificationEmail,
            enableGuardDuty: context.enableGuardDuty,
            enableSecurityHub: context.enableSecurityHub,
            enableAccessAnalyzer: context.enableAccessAnalyzer,
            env: cdkEnvironment(this.environment),
            description: `Account security baseline (GuardDuty, Security Hub, Access Analyzer) - ${env}`,
        });

        stacks.push(securityStack);
        stackMap['securityBaseline'] = securityStack;

        cdk.Annotations.of(scope).addInfo(
            `Shared factory created ${stacks.length} stacks. ` +
            `Other projects can reference this VPC using: -c useSharedVpc=Shared`,
        );

        return {
            stacks,
            stackMap,
        };
    }
}
