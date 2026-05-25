import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Used by `drizzle-kit generate` / `migrate` / `studio`. Runtime
// migrations are applied via the `migrate()` call in DatabaseService —
// this config is only for the CLI.
export default defineConfig({
  schema: './src/infrastructure/db/schema/index.ts',
  out: './src/infrastructure/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/app.sqlite',
  },
  verbose: true,
  strict: true,
});
