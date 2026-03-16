/** @format */

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 10000,
  verbose: false,
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        useESM: false,
        isolatedModules: true,
      },
    ],
  },
  moduleNameMapper: {
    '^@repo/script-utils/(.*)\\.js$': '<rootDir>/../packages/script-utils/src/$1',
    '^@repo/script-utils/(.*)$': '<rootDir>/../packages/script-utils/src/$1',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
