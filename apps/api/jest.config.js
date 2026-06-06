/** @type {import('jest').Config} */
// INTERIM CONFIG: ESM-only dependencies (octokit, @octokit/*, unified,
// remark-*, rehype-*) which jest@29's CommonJS runtime can't load.
// Two stop-gaps below:
//   1. `moduleNameMapper` redirects `octokit` and `@octokit/auth-app`
//      to tiny CJS stubs in test/stubs/. Tests never instantiate
//      the real Octokit — they override the `createClient` test
//      seam — so a no-op stub at the resolver boundary suffices.
//   2. The sanitizer pipeline (unified/remark/rehype) ships as ESM
//      too; sanitizer follows the same stub pattern when its tests land.
//
// Production runtime is unaffected — Node 22.12's `require(ESM)`
// handles the real packages natively. The principled fix is a full
// migration to Vitest (executed in parallel as a subagent task);
// when that lands the stubs and this whole interim block disappear.
// Tracked under "Deferred to Follow-Up Work" in
// docs/plans/06-day5-real-pr-integration.md.
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    // ESM stubs: The real `octokit` / `@octokit/auth-app`
    // packages are ESM-only and don't load under Jest's CJS runtime.
    // Tests never instantiate the real Octokit — they always
    // override the createClient seam — so a tiny CJS stub at the
    // resolver boundary is enough. Production runtime is untouched
    // (Node 22.12 native require(ESM)). Stubs disappear with the
    // Vitest migration.
    '^octokit$': '<rootDir>/test/stubs/octokit.cjs',
    '^@octokit/auth-app$': '<rootDir>/test/stubs/octokit-auth-app.cjs',
    // Sanitizer stubs — same rationale as octokit: the unified/remark/rehype
    // pipeline is ESM-only. Tests of format-review-body inject their own
    // sanitize fn; this stub satisfies the import boundary so the module loads.
    // Matches both relative ('./sanitize-finding-markdown') and
    // alias-resolved ('@/modules/reviews/helpers/sanitize-finding-markdown')
    // forms. Both specific mappers MUST sit above the generic `^@/(.*)$`
    // alias mapper below, because jest matches keys in order — without
    // this ordering the alias form falls through to the real ESM file.
    '^\\./sanitize-finding-markdown$':
      '<rootDir>/test/stubs/sanitize-finding-markdown.cjs',
    '^@/modules/reviews/helpers/sanitize-finding-markdown$':
      '<rootDir>/test/stubs/sanitize-finding-markdown.cjs',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFiles: ['<rootDir>/jest.setup.ts'],
};
