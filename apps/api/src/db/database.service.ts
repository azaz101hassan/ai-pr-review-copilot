import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PullRequestRecord {
  node_id: string;
  repo_full_name: string;
  number: number;
  title: string;
  state: string;
  head_sha: string;
  base_sha: string;
  author_login: string;
  created_at: string;
  updated_at: string;
  raw_payload: string;
}

export interface WebhookEventRecord {
  delivery_id: string;
  event_name: string;
  action: string | null;
  pull_request_node_id: string | null;
  received_at: string;
  raw_payload: string;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database.Database;
  private dbPath!: string;

  onModuleInit(): void {
    this.open();
  }

  open(dbPath?: string): void {
    const resolved = dbPath ?? process.env.DATABASE_PATH ?? './data/app.sqlite';
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

  insertOrReplacePullRequest(pr: PullRequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO pull_requests
         (node_id, repo_full_name, number, title, state, head_sha, base_sha,
          author_login, created_at, updated_at, raw_payload)
         VALUES (@node_id, @repo_full_name, @number, @title, @state, @head_sha,
                 @base_sha, @author_login, @created_at, @updated_at, @raw_payload)
         ON CONFLICT(node_id) DO UPDATE SET
           repo_full_name = excluded.repo_full_name,
           number         = excluded.number,
           title          = excluded.title,
           state          = excluded.state,
           head_sha       = excluded.head_sha,
           base_sha       = excluded.base_sha,
           author_login   = excluded.author_login,
           created_at     = excluded.created_at,
           updated_at     = excluded.updated_at,
           raw_payload    = excluded.raw_payload`,
      )
      .run(pr);
  }

  findPullRequest(nodeId: string): PullRequestRecord | undefined {
    return this.db
      .prepare('SELECT * FROM pull_requests WHERE node_id = ?')
      .get(nodeId) as PullRequestRecord | undefined;
  }

  insertWebhookEvent(event: WebhookEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO webhook_events
         (delivery_id, event_name, action, pull_request_node_id,
          received_at, raw_payload)
         VALUES (@delivery_id, @event_name, @action, @pull_request_node_id,
                 @received_at, @raw_payload)`,
      )
      .run(event);
  }

  findWebhookEvent(deliveryId: string): WebhookEventRecord | undefined {
    return this.db
      .prepare('SELECT * FROM webhook_events WHERE delivery_id = ?')
      .get(deliveryId) as WebhookEventRecord | undefined;
  }

  // Wraps `fn` in a single BEGIN…COMMIT (or ROLLBACK on throw). Use this
  // when a webhook needs to land >1 row atomically — e.g. PR upsert +
  // event insert must succeed together or not at all so a crash between
  // the two doesn't leave a PR row in the table with no audit event.
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
