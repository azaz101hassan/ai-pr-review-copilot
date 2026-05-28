// Test-only CommonJS stub for the ESM-only `@octokit/auth-app` package.
// See test/stubs/octokit.cjs header for rationale. The Vitest
// migration deletes this stub.

function createAppAuth(_options) {
  throw new Error(
    'octokit-auth-app stub: real auth construction is not allowed in tests.',
  );
}

module.exports = { createAppAuth };
