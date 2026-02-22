/**
 * @format
 * Naming Utilities Unit Tests
 *
 * Verifies the centralised stack naming functions produce correct
 * CloudFormation stack names / CDK construct IDs.
 */

import { Project } from '../../../lib/config/projects';
import {
    stackId,
    getStackId,
    STACK_REGISTRY,
    resourceName,
    logGroupName,
    exportName,
    describeCidr,
} from '../../../lib/utilities/naming';

describe('Naming Utilities', () => {
    // =========================================================================
    // stackId()
    // =========================================================================
    describe('stackId', () => {
        it('should generate {Namespace}-{Component}-{environment}', () => {
            expect(stackId('Monitoring', 'Storage', 'development')).toBe('Monitoring-Storage-development');
        });

        it('should handle multi-part namespace', () => {
            expect(stackId('Monitoring-K8s', 'Compute', 'production')).toBe('Monitoring-K8s-Compute-production');
        });

        it('should handle multi-part component', () => {
            expect(stackId('NextJS', 'K8s-Compute', 'staging')).toBe('NextJS-K8s-Compute-staging');
        });
    });

    // =========================================================================
    // getStackId()
    // =========================================================================
    describe('getStackId', () => {
        it('should resolve Monitoring project stacks', () => {
            expect(getStackId(Project.MONITORING, 'storage', 'development')).toBe('Monitoring-Storage-development');
            expect(getStackId(Project.MONITORING, 'ssm', 'staging')).toBe('Monitoring-SSM-staging');
            expect(getStackId(Project.MONITORING, 'compute', 'production')).toBe('Monitoring-Compute-production');
        });

        it('should resolve NextJS project stacks', () => {
            expect(getStackId(Project.NEXTJS, 'data', 'development')).toBe('NextJS-Data-development');
            expect(getStackId(Project.NEXTJS, 'compute', 'development')).toBe('NextJS-Compute-development');
            expect(getStackId(Project.NEXTJS, 'networking', 'development')).toBe('NextJS-Networking-development');
            expect(getStackId(Project.NEXTJS, 'application', 'development')).toBe('NextJS-Application-development');
            expect(getStackId(Project.NEXTJS, 'k8sCompute', 'development')).toBe('NextJS-K8s-Compute-development');
            expect(getStackId(Project.NEXTJS, 'api', 'development')).toBe('NextJS-Api-development');
            expect(getStackId(Project.NEXTJS, 'edge', 'production')).toBe('NextJS-Edge-production');
        });

        it('should resolve K8s project stacks', () => {
            expect(getStackId(Project.K8S, 'compute', 'development')).toBe('Monitoring-K8s-Compute-development');
            expect(getStackId(Project.K8S, 'edge', 'production')).toBe('Monitoring-K8s-Edge-production');
        });

        it('should resolve Shared project stacks', () => {
            expect(getStackId(Project.SHARED, 'infra', 'development')).toBe('Shared-Infra-development');
        });

        it('should resolve Org project stacks (normalized, no Stack suffix)', () => {
            expect(getStackId(Project.ORG, 'dnsRole', 'production')).toBe('Org-DnsRole-production');
        });

        it('should throw on invalid stack key', () => {
            expect(() => getStackId(Project.MONITORING, 'nonexistent', 'development')).toThrow(
                /Unknown stack key 'nonexistent'/
            );
        });
    });

    // =========================================================================
    // STACK_REGISTRY completeness
    // =========================================================================
    describe('STACK_REGISTRY', () => {
        it('should contain all project entries', () => {
            expect(Object.keys(STACK_REGISTRY)).toEqual(
                expect.arrayContaining(['shared', 'monitoring', 'nextjs', 'k8s', 'org'])
            );
        });

        it('should have expected monitoring stack keys', () => {
            expect(Object.keys(STACK_REGISTRY.monitoring)).toEqual(['storage', 'ssm', 'compute']);
        });

        it('should have expected nextjs stack keys', () => {
            expect(Object.keys(STACK_REGISTRY.nextjs)).toEqual(
                ['data', 'compute', 'networking', 'application', 'k8sCompute', 'api', 'edge']
            );
        });

        it('should have expected k8s stack keys', () => {
            expect(Object.keys(STACK_REGISTRY.k8s)).toEqual(['compute', 'edge']);
        });
    });

    // =========================================================================
    // Existing utility functions (unchanged behaviour)
    // =========================================================================
    describe('resourceName', () => {
        it('should join parts with hyphens', () => {
            expect(resourceName({ project: 'monitoring', component: 'vpc', environment: 'development' }))
                .toBe('monitoring-vpc-development');
        });

        it('should omit missing parts', () => {
            expect(resourceName({ project: 'monitoring' })).toBe('monitoring');
        });
    });

    describe('logGroupName', () => {
        it('should generate /{project}/{component}/{environment}', () => {
            expect(logGroupName('monitoring', 'compute', 'development')).toBe('/monitoring/compute/development');
        });
    });

    describe('exportName', () => {
        it('should generate {project}-{component}-{output}-{environment}', () => {
            expect(exportName('monitoring', 'compute', 'role-arn', 'development'))
                .toBe('monitoring-compute-role-arn-development');
        });
    });

    describe('describeCidr', () => {
        it('should describe /32 as IP', () => {
            expect(describeCidr('10.0.0.1/32')).toBe('IP 10.0.0.1');
        });

        it('should describe /0 as All IPs', () => {
            expect(describeCidr('0.0.0.0/0')).toBe('All IPs (0.0.0.0/0)');
        });
    });
});
