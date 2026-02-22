/**
 * @format
 * Organization Project Factory
 *
 * Factory for creating AWS Organization and root account resources.
 * This project deploys to the management/root account only.
 *
 * Stacks:
 * 1. DnsRoleStack - Cross-account DNS validation for ACM certificates
 *
 * Future stacks (deferred):
 * - ScpStack - Service Control Policies
 * - OUStack - Organizational Units
 * - BillingStack - Budget alarms and cost monitoring
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../config/environments';
import { Project, getProjectConfig } from '../../config/projects';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import { CrossAccountDnsRoleStack } from '../../stacks/org';
import { stackId } from '../../utilities/naming';

export interface OrgProjectConfig {
    /**
     * Route 53 Hosted Zone ID(s) to allow access to
     */
    readonly hostedZoneIds: string[];

    /**
     * AWS account IDs that are allowed to assume the DNS role
     * (dev, staging, prod accounts)
     */
    readonly trustedAccountIds: string[];

    /**
     * External ID for additional security (optional)
     */
    readonly externalId?: string;
}

/**
 * Extended factory context for Org project.
 * All fields are optional — the factory resolves from CDK context
 * (-c hostedZoneIds=... -c trustedAccountIds=...) when not provided.
 */
export interface OrgFactoryContext extends ProjectFactoryContext {
    /** Hosted zone IDs (comma-separated string) */
    hostedZoneIds?: string;
    /** Trusted account IDs (comma-separated string) */
    trustedAccountIds?: string;
    /** External ID for additional security */
    externalId?: string;
}

/**
 * Organization Project Factory
 *
 * Creates stacks for AWS Organization and root account resources.
 * Deploy this project to the management/root account only.
 *
 * @example
 * ```typescript
 * const factory = new OrgProjectFactory(Environment.PRODUCTION);
 * factory.createAllStacks(app, {
 *     environment: Environment.PRODUCTION,
 *     hostedZoneIds: ['Z04763221QPB6CZ9R77GM'],
 *     trustedAccountIds: ['771826808455', '607700977986', '692738841103'],
 * });
 * ```
 */
export class OrgProjectFactory implements IProjectFactory<OrgFactoryContext> {
    readonly project = Project.ORG;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.ORG).namespace;
    }

    /**
     * Create all organization stacks
     */
    createAllStacks(scope: cdk.App, context: OrgFactoryContext): ProjectStackFamily {
        const stacks: cdk.Stack[] = [];
        const stackMap: Record<string, cdk.Stack> = {};
        const namePrefix = `${this.namespace}-${this.environment}`;

        // Resolve org-specific config: explicit context > CDK context
        const hostedZoneIdsRaw = context.hostedZoneIds
            ?? scope.node.tryGetContext('hostedZoneIds') as string | undefined;
        const trustedAccountIdsRaw = context.trustedAccountIds
            ?? scope.node.tryGetContext('trustedAccountIds') as string | undefined;
        const externalId = context.externalId
            ?? scope.node.tryGetContext('externalId') as string | undefined;

        // Parse comma-separated strings into arrays if needed
        const hostedZoneIds = Array.isArray(hostedZoneIdsRaw)
            ? hostedZoneIdsRaw
            : hostedZoneIdsRaw?.split(',').map((s) => s.trim()).filter(Boolean);

        const trustedAccountIds = Array.isArray(trustedAccountIdsRaw)
            ? trustedAccountIdsRaw
            : trustedAccountIdsRaw?.split(',').map((s) => s.trim()).filter(Boolean);

        // Validate required org-specific config
        if (!hostedZoneIds || hostedZoneIds.length === 0) {
            throw new Error('hostedZoneIds is required for org project. Pass via context.');
        }
        if (!trustedAccountIds || trustedAccountIds.length === 0) {
            throw new Error('trustedAccountIds is required for org project. Pass via context.');
        }

        const env = {
            account: process.env.ROOT_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT,
            region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'eu-west-1',
        };

        // =================================================================
        // Stack 1: Cross-Account DNS Role
        // =================================================================
        const dnsRoleStack = new CrossAccountDnsRoleStack(scope, stackId(this.namespace, 'DnsRole', this.environment), {
            hostedZoneIds,
            trustedAccountIds,
            externalId,
            namePrefix,
            env,
        });
        stacks.push(dnsRoleStack);
        stackMap['DnsRole'] = dnsRoleStack;

        // =================================================================
        // Future: SCP Stack (deferred)
        // =================================================================
        // const scpStack = new ServiceControlPoliciesStack(scope, this.stackId('Scp'), {
        //     namePrefix,
        //     env,
        // });
        // stacks.push(scpStack);
        // stackMap['Scp'] = scpStack;

        return { stacks, stackMap };
    }

}
