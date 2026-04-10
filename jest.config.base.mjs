export const esmConfig = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: './tsconfig.json'
    }]
  },
  roots: ['<rootDir>'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk\\.out/'],
  clearMocks: true,
  resetModules: true,
};
