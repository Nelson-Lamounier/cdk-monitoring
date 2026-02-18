/**
 * @format
 * Project Registry Unit Tests
 *
 * Tests for the factory registry that maps project+environment to factories.
 */

import { Environment } from '../../../lib/config';
import { Project } from '../../../lib/config/projects';
import {
    getProjectFactory,
    getProjectFactoryFromContext,
    hasProjectFactory,
} from '../../../lib/factories/project-registry';
import { MonitoringProjectFactory } from '../../../lib/projects/monitoring';
import { NextJSProjectFactory } from '../../../lib/projects/nextjs';

describe('Project Registry', () => {
    describe('getProjectFactory', () => {
        it('should return MonitoringProjectFactory for MONITORING project', () => {
            const factory = getProjectFactory(Project.MONITORING, Environment.DEVELOPMENT);
            expect(factory).toBeInstanceOf(MonitoringProjectFactory);
            expect(factory.project).toBe(Project.MONITORING);
            expect(factory.environment).toBe(Environment.DEVELOPMENT);
        });

        it('should return NextJSProjectFactory for NEXTJS project', () => {
            const factory = getProjectFactory(Project.NEXTJS, Environment.PRODUCTION);
            expect(factory).toBeInstanceOf(NextJSProjectFactory);
            expect(factory.project).toBe(Project.NEXTJS);
            expect(factory.environment).toBe(Environment.PRODUCTION);
        });

        it('should work with all environment types', () => {
            [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION].forEach(env => {
                const factory = getProjectFactory(Project.MONITORING, env);
                expect(factory.environment).toBe(env);
            });
        });
    });

    describe('getProjectFactoryFromContext', () => {
        it('should parse valid project and environment strings', () => {
            const factory = getProjectFactoryFromContext('monitoring', 'dev');
            expect(factory).toBeInstanceOf(MonitoringProjectFactory);
            expect(factory.environment).toBe(Environment.DEVELOPMENT);
        });

        it('should parse nextjs project', () => {
            const factory = getProjectFactoryFromContext('nextjs', 'staging');
            expect(factory).toBeInstanceOf(NextJSProjectFactory);
            expect(factory.environment).toBe(Environment.STAGING);
        });

        it('should throw for invalid project string', () => {
            expect(() => {
                getProjectFactoryFromContext('invalid-project', 'dev');
            }).toThrow(/Invalid project.*invalid-project/);
        });

        it('should throw for invalid environment string', () => {
            expect(() => {
                getProjectFactoryFromContext('monitoring', 'invalid-env');
            }).toThrow(/Invalid environment.*invalid-env/);
        });
    });

    describe('hasProjectFactory', () => {
        it('should return true for registered projects', () => {
            expect(hasProjectFactory(Project.MONITORING)).toBe(true);
            expect(hasProjectFactory(Project.NEXTJS)).toBe(true);
        });
    });

    describe('Factory Properties', () => {
        it('should set correct namespace for monitoring', () => {
            const factory = getProjectFactory(Project.MONITORING, Environment.DEVELOPMENT);
            expect(factory.namespace).toBe('Monitoring');
        });

        it('should set correct namespace for nextjs', () => {
            const factory = getProjectFactory(Project.NEXTJS, Environment.DEVELOPMENT);
            expect(factory.namespace).toBe('NextJS');
        });
    });
});
