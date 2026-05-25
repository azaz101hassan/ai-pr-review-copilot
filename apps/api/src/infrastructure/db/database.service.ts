import {
  Injectable,
  Logger,
  Optional,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from '@/config';

// Owns the SQLite connection lifecycle ONLY — open, close, transaction,
// and schema bootstrap. Per-table queries live in repository classes that
// inject this service and call getDb() to reach the underlying handle.
// Splitting CRUD out of this class keeps it stable as we add tables and
// gives modules a single seam to swap (postgres, libsql, …) by binding
// a different repository implementation in their module providers.
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database.Database;
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

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(this.loadSchema());
    this.logger.log(`SQLite ready at ${this.dbPath}`);
  }

  onApplicationShutdown(): void {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  // Wraps `fn` in a single BEGIN…COMMIT (or ROLLBACK on throw). Use this
  // when a domain operation needs >1 row to land atomically — e.g. a PR
  // upsert + event insert must succeed together or not at all so a crash
  // between the two doesn't leave a PR row in the table with no audit
  // event.
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  hasTable(name: string): boolean {
    const row = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name);
    return !!row;
  }

  getDb(): Database.Database {
    return this.db;
  }

  private loadSchema(): string {
    const schemaPath = path.join(__dirname, 'schema.sql');
    return fs.readFileSync(schemaPath, 'utf8');
  }
}
