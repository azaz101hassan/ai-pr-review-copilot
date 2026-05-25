import {
  Injectable,
  Logger,
  Optional,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from '@/config';
import * as schema from './schema';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

// Owns the SQLite connection lifecycle — open, close, transaction, and
// schema bootstrap via Drizzle migrations. Per-table queries live in
// repository classes that inject this service and call `drizzle` (the
// typed Drizzle client) for their queries; `db` (the raw better-sqlite3
// handle) remains exposed for pragmas and the lifecycle test surface.
//
// Swapping persistence engines means swapping the repository
// implementations, not this class.
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private rawDb!: Database.Database;
  private drizzleDb!: DrizzleDb;
  private dbPath!: string;

  // @Optional() so unit tests can construct DatabaseService standalone
  // and call open(path) with an explicit temp path. Production always
  // gets ConfigService injected and uses its databasePath.
  constructor(@Optional() private readonly config?: ConfigService) {}

  onModuleInit(): void {
    this.open();
  }

  open(dbPath?: string): void {
    const resolved =
      dbPath ??
      this.config?.databasePath ??
      process.env.DATABASE_PATH ??
      './data/app.sqlite';
    this.dbPath = resolved === ':memory:' ? ':memory:' : path.resolve(resolved);

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.rawDb = new Database(this.dbPath);
    this.rawDb.pragma('journal_mode = WAL');
    this.rawDb.pragma('foreign_keys = ON');

    // Wrap the raw connection in Drizzle, then apply pending migrations.
    // The migrations folder is co-located with the schema and ships
    // with the dist build (jest reads them directly via __dirname).
    this.drizzleDb = drizzle(this.rawDb, { schema });
    migrate(this.drizzleDb, {
      migrationsFolder: path.join(__dirname, 'migrations'),
    });

    this.logger.log(`SQLite ready at ${this.dbPath}`);
  }

  onApplicationShutdown(): void {
    if (this.rawDb && this.rawDb.open) {
      this.rawDb.close();
    }
  }

  // Wraps `fn` in a single BEGIN…COMMIT (or ROLLBACK on throw). Use this
  // when a domain operation needs >1 row to land atomically — e.g. a PR
  // upsert + event insert must succeed together or not at all so a crash
  // between the two doesn't leave a PR row in the table with no audit
  // event. better-sqlite3's transaction works on the underlying handle
  // regardless of whether queries inside are issued via Drizzle or raw.
  transaction<T>(fn: () => T): T {
    return this.rawDb.transaction(fn)();
  }

  hasTable(name: string): boolean {
    const row = this.rawDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name);
    return !!row;
  }

  // Typed Drizzle client. Repositories depend on this — the schema
  // generic gives them inferred row types for every table.
  get drizzle(): DrizzleDb {
    return this.drizzleDb;
  }

  // Raw better-sqlite3 handle. Kept for lifecycle tests (pragma checks)
  // and any one-off escape hatches. Repositories should prefer
  // `drizzle` above.
  getDb(): Database.Database {
    return this.rawDb;
  }
}
