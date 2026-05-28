// Test-only CommonJS stub for the ESM-only `unified`/`remark-*`/
// `rehype-*` pipeline used by sanitize-finding-markdown. Stubs at
// the helper boundary so format-review-body's IMPORT of the
// sanitizer resolves cleanly under jest's CJS runtime.
//
// The stub does a deliberately tiny passthrough — enough to verify
// the formatter's wiring (the sanitizer was called, output flowed
// through) without exercising the real sanitization (deferred to
// Vitest migration via the prompt-injection corpus). Production
// runtime is untouched; Node 22.12's require(ESM) covers the real
// helper.

function sanitizeFindingMarkdown(input) {
  if (!input) return '';
  // Mark every passthrough so tests can assert "the sanitizer was
  // hit" without depending on whitespace coincidence.
  return `[stub]${String(input)}[/stub]`;
}

module.exports = { sanitizeFindingMarkdown };
