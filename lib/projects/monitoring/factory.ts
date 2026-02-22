/**
 * @format
 * Monitoring Project Factory (Consolidated 3-Stack)
 *
 * Creates Grafana/Prometheus monitoring infrastructure using consolidated stacks.
 * Uses vpcName prop so each stack performs its own Vpc.fromLookup() at synth time,
 * avoiding implicit CloudFormation cross-stack exports.
 *
 * Stacks created:
 * - StorageStack: EBS volume + Lifecycle Lambda
 * - SsmStack: SSM Run Command document + S3 scripts bucket
 * - ComputeStack: Security Group + EC2/ASG compute
 */

import * as cdk from 'aws-cdk-lib/core';

import { MONITORING_APP_TAG } from '../../config/defaults';
import { Environment, cdkEnvironment } from '../../config/environments';
import { getMonitoringConfigs } from '../../config/monitoring';
import { stackId } from '../../utilities/naming';
import { Project, getProjectConfig } from '../../config/projects';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    MonitoringStorageStack,
    MonitoringComputeStack,
    MonitoringSsmStack,
} from '../../stacks/monitoring';

// =========================================================================
// Factory Context
// =========================================================================

/**
 * Extended factory context with monitoring-specific overrides.
 *
 * All synth-time values (trustedCidrs, grafanaPassword) come from
 * the typed config file (MonitoringConfigs). Only factory-internal
 * fields remain here as optional overrides.
 */
export interface MonitoringFactoryContext extends ProjectFactoryContext {
    /** Override trustedCidrs from config (used by tests and local dev env var bridge) */
    trustedCidrs?: string[];
    /** Override grafanaPassword from config (used by tests and env var bridge in app.ts) */
    grafanaPassword?: string;
}

/**
 * Monitoring project factory.
 * Creates EC2-based Grafana/Prometheus monitoring infrastructure.
 * Uses consolidated 3-stack architecture for simpler deployment.
 *
 * VPC Discovery: Passes `vpcName` (Name tag: `shared-vpc-{environment}`) to each stack,
 * which performs its own Vpc.fromLookup() at synth time. This avoids implicit
 * CloudFormation exports that would couple the VPC stack to monitoring stacks.
 */
export class MonitoringProjectFactory implements IProjectFactory<MonitoringFactoryContext> {
    readonly project = Project.MONITORING;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.MONITORING).namespace;
    }



    createAllStacks(scope: cdk.App, context: MonitoringFactoryContext): ProjectStackFamily {
        // -------------------------------------------------------------
        // Load typed config for this environment
        // -------------------------------------------------------------
        const config = getMonitoringConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        // Context overrides > typed config defaults
        const trustedCidrs = context.trustedCidrs ?? config.trustedCidrs;
        const namePrefix = `${this.namespace.toLowerCase()}-${this.environment}`;

        // Grafana password: context override > config > 'admin' default for non-prod
        // Production MUST have an explicit password (from env var bridge in app.ts)
        const grafanaPassword = context.grafanaPassword
            ?? config.grafanaAdminPassword
            ?? (this.environment === Environment.PRODUCTION
                ? (() => { throw new Error(
                    'Missing GRAFANA_ADMIN_PASSWORD for production. ' +
                    'Set this variable in your CI/CD pipeline or local environment.'
                ); })()
                : 'admin');

        // =================================================================
        // VPC Discovery
        //
        // Each stack performs its own Vpc.fromLookup() using the Name tag.
        // This resolves at synth time via CDK context caching (cdk.context.json)
        // and embeds concrete VPC/subnet IDs directly into each template.
        // No CloudFormation exports are needed between stacks.
        // =================================================================
        const vpcName = `shared-vpc-${this.environment}`;

        // =================================================================
        // Stack 1: Storage (EBS Volume + Lifecycle)
        //
        // Production: 50GB for 30-90 day Prometheus retention
        // Dev/Staging: 30GB for 15 day retention
        // All environments: DLM nightly snapshots (7-day retention)
        // =================================================================
        const volumeSizeGb = this.environment === Environment.PRODUCTION ? 50 : 30;
        const removalPolicy = config.removalPolicy;

        // ASG name follows the naming convention: {namePrefix}-asg
        // Must be passed to StorageStack so the EBS detach lifecycle Lambda is created
        const asgName = `${namePrefix}-asg`;
        const storageStack = new MonitoringStorageStack(
            scope,
            stackId(this.namespace, 'Storage', this.environment),
            {
                vpcName,
                volumeSizeGb,
                createEncryptionKey: config.createKmsKeys,
                removalPolicy,
                enableBackup: true,  // DLM snapshots for all environments
                namePrefix,
                env,
                // EBS lifecycle management: Lambda + EventBridge detach the
                // volume before ASG terminates the old instance
                asgName,
                volumeTagKey: MONITORING_APP_TAG.key,
                volumeTagValue: MONITORING_APP_TAG.value,
            }
        );

        // =================================================================
        // Stack 2: SSM (Run Command Document + S3 Scripts)
        //
        // Owns the SSM document that configures the monitoring stack and
        // the S3 bucket with docker-compose + config files.
        // Writes discovery parameters to SSM so Compute can find them.
        // No dependency on Storage or Compute stacks.
        // =================================================================
        const ssmStack = new MonitoringSsmStack(
            scope,
            stackId(this.namespace, 'SSM', this.environment),
            {
                namePrefix,
                grafanaAdminPassword: grafanaPassword,
                steampipeAccounts: config.steampipeAccounts,
                env,
            }
        );

        // =================================================================
        // Stack 3: Compute (Security Group + EC2/ASG)
        //
        // Zero external ingress - access via SSM port forwarding:
        //   aws ssm start-session --target i-xxx --document-name AWS-StartPortForwardingSession \
        //     --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'
        //
        // Discovers SSM document name and scripts bucket via SSM parameters
        // written by the SSM stack — no cross-stack dependency.
        // =================================================================
        const computeStack = new MonitoringComputeStack(
            scope,
            stackId(this.namespace, 'Compute', this.environment),
            {
                vpcName,
                trustedCidrs,
                ssmOnlyAccess: true,  // SSM port forwarding for all environments
                volumeId: storageStack.volumeId,
                volumeAz: storageStack.availabilityZone,
                ebsEncryptionKey: storageStack.encryptionKey,
                namePrefix,
                env,
            }
        );
        computeStack.addDependency(storageStack);
        computeStack.addDependency(ssmStack);

        const stacks: cdk.Stack[] = [storageStack, ssmStack, computeStack];

        cdk.Annotations.of(scope).addInfo(
            `Monitoring factory created ${stacks.length} stacks for ${this.environment} ` +
            `(VPC: ${vpcName})`,
        );

        return {
            stacks,
            stackMap: {
                storage: storageStack,
                ssm: ssmStack,
                compute: computeStack,
            },
        };
    }
}
