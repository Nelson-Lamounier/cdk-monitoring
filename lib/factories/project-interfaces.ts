/**
 * @format
 * Project Factory Interfaces
 *
 * Defines the interface for project-specific factories that create
 * project stacks. Each factory owns its own context resolution
 * (VPC lookup, env vars, secrets) — the entry point only provides
 * the target environment.
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../config/environments';
import { Project } from '../config/projects';

/**
 * Base context passed to project factories for stack creation.
 *
 * Only the target environment is required. Each factory defines
 * its own extended context interface for project-specific
 * configuration (domain names, trusted CIDRs, etc.).
 */
export interface ProjectFactoryContext {
    /** Target environment */
    readonly environment: Environment;
    /** Allow project-specific context overrides (e.g., domainName, hostedZoneId) */
    readonly [key: string]: unknown;
}

/**
 * Result of creating all stacks for a project
 */
export interface ProjectStackFamily {
    /** All stacks created by the factory */
    readonly stacks: cdk.Stack[];
    /** Map of stack name to stack instance */
    readonly stackMap: Record<string, cdk.Stack>;
}

/**
 * Interface for project-specific factories.
 * Each project (monitoring, nextjs, etc.) implements this interface
 * with its own typed context.
 *
 * @typeParam TContext - Factory-specific context extending ProjectFactoryContext
 */
export interface IProjectFactory<TContext extends ProjectFactoryContext = ProjectFactoryContext> {
    /** The project this factory creates stacks for */
    readonly project: Project;
    /** The target environment */
    readonly environment: Environment;
    /** The namespace prefix for stack names */
    readonly namespace: string;

    /**
     * Create all stacks for this project.
     * Each factory resolves its own VPC, env vars, and secrets.
     *
     * @param scope - CDK app or stage
     * @param context - Typed context with environment and optional project-specific overrides
     */
    createAllStacks(scope: cdk.App, context: TContext): ProjectStackFamily;
}

/**
 * Constructor type for project factories.
 * Uses `IProjectFactory<any>` so the registry can store heterogeneous factory types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProjectFactoryConstructor = new (environment: Environment) => IProjectFactory<any>;
