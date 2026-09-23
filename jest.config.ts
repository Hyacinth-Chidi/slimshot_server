import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**'],
  coveragePathIgnorePatterns: ['/node_modules/', '/src/generated/'],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  // `.worktrees/` holds full checkouts of this same repo, so without ignoring it
  // jest discovers every spec twice and reports double the real count.
  //
  // Anchored to <rootDir>: an unanchored '/\.worktrees/' also matches when jest
  // runs from INSIDE a worktree, because every spec's absolute path then
  // contains that segment — which excludes the whole suite and reports zero
  // tests as a pass.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '<rootDir>/\\.worktrees/',
  ],
};

module.exports = config;
