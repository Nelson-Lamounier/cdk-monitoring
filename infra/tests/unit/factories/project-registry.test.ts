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

describe('Project Registry', () => {
    describe('getProjectFactory', () => {
        it('should return KubernetesProjectFactory for KUBERNETES project', () => {
            const factory = getProjectFactory(Project.KUBERNETES, Environment.DEVELOPMENT);
            expect(factory.project).toBe(Project.KUBERNETES);
            expect(factory.environment).toBe(Environment.DEVELOPMENT);
        });

        it('should work with all environment types', () => {
            [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION].forEach(env => {
                const factory = getProjectFactory(Project.KUBERNETES, env);
                expect(factory.environment).toBe(env);
            });
        });
    });

    describe('getProjectFactoryFromContext', () => {
        it('should parse valid project and environment strings', () => {
            const factory = getProjectFactoryFromContext('kubernetes', 'dev');
            expect(factory.environment).toBe(Environment.DEVELOPMENT);
        });

        it('should throw for invalid project string', () => {
            expect(() => {
                getProjectFactoryFromContext('invalid-project', 'dev');
            }).toThrow(/Invalid project.*invalid-project/);
        });

        it('should throw for invalid environment string', () => {
            expect(() => {
                getProjectFactoryFromContext('kubernetes', 'invalid-env');
            }).toThrow(/Invalid environment.*invalid-env/);
        });
    });

    describe('hasProjectFactory', () => {
        it('should return true for registered projects', () => {
            expect(hasProjectFactory(Project.KUBERNETES)).toBe(true);
            expect(hasProjectFactory(Project.BEDROCK)).toBe(true);
        });
    });
});
