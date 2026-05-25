import { Injectable } from '@nestjs/common';

// Single typed gateway to process.env. Read once at boot, fail fast on
// misconfig, hand strongly-typed values to consumers. Reasons we own a
// hand-rolled one instead of @nestjs/config for now:
//  - Day 1 has 3 vars total; the dependency isn't paying its way yet.
//  - Inline validation lives next to the consumer's mental model
//    (the guard's "16+ chars" rule lives here, not in a Joi schema).
//  - We can move to @nestjs/config + Joi when the surface grows past
//    ~10 vars or we need per-environment .env layering.
@Injectable()
export class ConfigService {
  readonly githubWebhookSecret: string;
  readonly databasePath: string;
  readonly port: number;

  constructor() {
    this.githubWebhookSecret = this.requireSecret(
      'GITHUB_WEBHOOK_SECRET',
      process.env.GITHUB_WEBHOOK_SECRET,
    );
    this.databasePath = process.env.DATABASE_PATH ?? './data/app.sqlite';
    this.port = Number(process.env.PORT) || 3001;
  }

  // Reject the truthy-but-broken cases too: literal "undefined"/"null"
  // (common from `${VAR:-undefined}` templating or `String(undef)`),
  // and anything shorter than 16 chars (`openssl rand -hex 32`
  // produces 64). The bar isn't strong-secret enforcement; it's
  // catching obvious misconfigs before they authenticate strangers.
  private requireSecret(name: string, value: string | undefined): string {
    if (!value || value === 'undefined' || value === 'null' || value.length < 16) {
      throw new Error(
        `${name} is missing, a placeholder ("undefined"/"null"), or shorter than 16 characters. Generate one with \`openssl rand -hex 32\` and put it in apps/api/.env before starting apps/api.`,
      );
    }
    return value;
  }
}
