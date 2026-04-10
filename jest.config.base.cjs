const cjsConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: './tsconfig.json'
    }]
  },
  roots: ['<rootDir>'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk\\.out/'],
  clearMocks: true,
};

module.exports = { cjsConfig };
