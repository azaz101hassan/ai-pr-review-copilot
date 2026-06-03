// Jest setup — runs once per worker before any spec loads.
//
// ConfigService requires several env vars at construction. Specs
// that compile the full AppModule (the *.e2e-spec.ts files, plus
// the anthropic integration spec) would fail unless those vars are
// set in process.env. Rather than touching every spec's beforeAll,
// we prime the values here. Specs that test the missing/invalid
// branches (notably config.service.spec.ts) snapshot+restore
// process.env themselves using the existing per-spec pattern, so
// they remain in full control of their own keys. The values below
// are intentionally inert: a short numeric App ID, a syntactically-
// valid PEM stub, and a localhost Redis URL. They never touch real
// services.
process.env.GITHUB_WEBHOOK_SECRET ??= 'jest-setup-webhook-secret-0123456789';
process.env.VOYAGE_API_KEY ??= 'jest-setup-voyage-key-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ??= 'jest-setup-anthropic-key-0123456789abcdef';

// GitHub App + Redis vars — see ConfigService for validation rules.
process.env.APP_ID ??= '123456';
process.env.APP_PRIVATE_KEY ??=
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEjest\n-----END RSA PRIVATE KEY-----';
process.env.REDIS_URL ??= 'redis://:test-password@localhost:6379';
// Skip the GET /app boot probe by default in every spec so
// AppModule-bootstrapping tests don't need real App credentials.
// The probe path itself is exercised explicitly by
// github-app.service.spec.ts.
process.env.SKIP_GITHUB_APP_PROBE ??= 'true';
// Same shape for the BullMQ Redis PING probe — tests don't need a
// real Redis available; the unit specs cover the probe path
// directly. Production must leave this unset.
process.env.SKIP_REDIS_PROBE ??= 'true';
