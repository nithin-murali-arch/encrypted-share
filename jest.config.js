module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/cli.ts'],
  coverageThreshold: {
    global: { statements: 80, lines: 80, branches: 70, functions: 80 },
  },
};
