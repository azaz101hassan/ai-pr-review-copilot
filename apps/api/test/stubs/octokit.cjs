// Test-only CommonJS stub for the ESM-only `octokit` package.
//
// Jest still runs in CommonJS mode and can't import the real
// `octokit` package (ESM-only). Production runtime is unaffected —
// Node 22.12's `require(ESM)` covers it. This stub only needs to
// export the names test code references at IMPORT time; every spec
// either overrides `createClient`/`createProbeClient` (so the stub
// Octokit constructor is never invoked) or provides a mock at the
// call site. A future Vitest migration can drop this stub.

class Octokit {
  constructor(_options) {
    throw new Error(
      'octokit stub: real Octokit construction is not allowed in tests. Override createClient() in a test subclass instead.',
    );
  }
}

class RequestError extends Error {
  constructor(message, status, options) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.options = options;
  }
}

module.exports = { Octokit, RequestError };
