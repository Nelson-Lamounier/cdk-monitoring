/**
 * @format
 * Shared Project Factory
 *
 * Creates shared infrastructure (VPC) used by multiple projects.
 * This project should be deployed first before other projects.
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

/**
 * Factory for creating shared infrastructure resources.
 *
 * Creates:
 * - VPC stack with public subnets, SSM exports, and flow logs
 *
 * @example
 * ```typescript
 * const factory = new SharedProjectFactory(Environment.DEVELOPMENT);
 * const result = factory.createAllStacks(app, context);
 * ```
 */
export class SharedProjectFactory implements IProjectFactory {
    public readonly project = Project.SHARED;
    public readonly environment: Environment;
    public readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.SHARED).namespace;
    }

    createAllStacks(scope: cdk.App, context: ProjectFactoryContext): ProjectStackFamily {
        const env = context.environment;
        const stackMap: Record<string, cdk.Stack> = {};

        console.log(`\n🏗️  Creating Shared infrastructure for ${env}...\n`);

        // =================================================================
        // Infrastructure Stack - VPC + ECR shared by all projects
        // =================================================================
        const infraStack = new SharedVpcStack(scope, `${this.namespace}-Infra-${env}`, {
            targetEnvironment: env,
            flowLogConfig: {
                logGroupName: `/vpc/${this.namespace.toLowerCase()}/${env}/flow-logs`,
                createEncryptionKey: env !== Environment.DEVELOPMENT,
            },
            env: cdkEnvironment(this.environment),
        });

        stackMap['infra'] = infraStack;

        console.log(`✅ Shared factory created 1 stack for ${env}:`);
        console.log(`   - ${this.namespace}-Infra-${env}`);
        console.log(`\nOther projects can reference this VPC using:`);
        console.log(`   -c useSharedVpc=Shared`);

        return {
            stacks: [infraStack],
            stackMap,
        };
    }
}
