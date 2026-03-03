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
            expect(stackId('K8s', 'Storage', 'development')).toBe('K8s-Storage-development');
        });

        it('should handle multi-part namespace', () => {
            expect(stackId('Monitoring-K8s', 'Compute', 'production')).toBe('Monitoring-K8s-Compute-production');
        });

        it('should handle empty namespace', () => {
            expect(stackId('', 'ControlPlane', 'development')).toBe('ControlPlane-development');
        });
    });

    // =========================================================================
    // getStackId()
    // =========================================================================
    describe('getStackId', () => {
        it('should resolve K8s project stacks', () => {
            // K8s project namespace is empty — stack names use component only
            expect(getStackId(Project.KUBERNETES, 'controlPlane', 'development')).toBe('ControlPlane-development');
            expect(getStackId(Project.KUBERNETES, 'goldenAmi', 'development')).toBe('GoldenAmi-development');
            expect(getStackId(Project.KUBERNETES, 'edge', 'production')).toBe('Edge-production');
        });

        it('should resolve Shared project stacks', () => {
            expect(getStackId(Project.SHARED, 'infra', 'development')).toBe('Shared-Infra-development');
        });

        it('should resolve Org project stacks (normalized, no Stack suffix)', () => {
            expect(getStackId(Project.ORG, 'dnsRole', 'production')).toBe('Org-DnsRole-production');
        });

        it('should resolve Bedrock project stacks', () => {
            expect(getStackId(Project.BEDROCK, 'data', 'development')).toBe('Bedrock-Data-development');
            expect(getStackId(Project.BEDROCK, 'agent', 'development')).toBe('Bedrock-Agent-development');
            expect(getStackId(Project.BEDROCK, 'api', 'production')).toBe('Bedrock-Api-production');
        });

        it('should throw on invalid stack key', () => {
            expect(() => getStackId(Project.KUBERNETES, 'nonexistent', 'development')).toThrow(
                /Unknown stack key 'nonexistent'/
            );
        });
    });

    // =========================================================================
    // STACK_REGISTRY completeness
    // =========================================================================
    describe('STACK_REGISTRY', () => {
        it('should contain all project entries', () => {
            expect(Object.keys(STACK_REGISTRY)).toStrictEqual(
                expect.arrayContaining(['shared', 'kubernetes', 'org', 'bedrock'])
            );
        });

        it('should have expected k8s stack keys', () => {
            expect(Object.keys(STACK_REGISTRY.kubernetes)).toStrictEqual(['data', 'base', 'goldenAmi', 'ssmAutomation', 'controlPlane', 'appWorker', 'monitoringWorker', 'appIam', 'api', 'edge']);
        });

        it('should have expected bedrock stack keys', () => {
            expect(Object.keys(STACK_REGISTRY.bedrock)).toStrictEqual(['data', 'agent', 'api', 'content']);
        });
    });

    // =========================================================================
    // Existing utility functions
    // =========================================================================
    describe('resourceName', () => {
        it('should join parts with hyphens', () => {
            expect(resourceName({ project: 'k8s', component: 'vpc', environment: 'development' }))
                .toBe('k8s-vpc-development');
        });

        it('should omit missing parts', () => {
            expect(resourceName({ project: 'k8s' })).toBe('k8s');
        });
    });

    describe('logGroupName', () => {
        it('should generate /{project}/{component}/{environment}', () => {
            expect(logGroupName('k8s', 'compute', 'development')).toBe('/k8s/compute/development');
        });
    });

    describe('exportName', () => {
        it('should generate {project}-{component}-{output}-{environment}', () => {
            expect(exportName('k8s', 'compute', 'role-arn', 'development'))
                .toBe('k8s-compute-role-arn-development');
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
