// Dev CLI for ad-hoc retrieval — `npm run query:rules --workspace apps/api -- <patch-file>`.
//
// Reads the diff text from the file path passed as argv[2] (or stdin if
// no arg), embeds it, queries the vector store, prints a small table
// of hits. `--k=<n>` overrides the default top-K.

import 'dotenv/config';
import * as fs from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { EmbeddingsService, SearchHit } from '@/modules/embeddings';

interface ParsedArgs {
  patchPath: string | undefined;
  k: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { patchPath: undefined, k: 10 };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice(4));
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        throw new Error(`--k must be an integer between 1 and 100 (got "${raw}")`);
      }
      args.k = n;
    } else if (raw === '--help' || raw === '-h') {
      printUsage();
      process.exit(0);
    } else if (!args.patchPath) {
      args.patchPath = raw;
    } else {
      throw new Error(`Unexpected positional argument: ${raw}`);
    }
  }
  return args;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    'Usage: npm run query:rules --workspace apps/api -- <patch-file> [--k=<n>]\n\n' +
      'Reads diff text from <patch-file> (or stdin if omitted), runs vector retrieval,\n' +
      'prints the top-K matching rules ranked by score.\n',
  );
}

async function readDiff(patchPath: string | undefined): Promise<string> {
  if (patchPath) {
    if (!fs.existsSync(patchPath)) {
      throw new Error(`Patch file not found: ${patchPath}`);
    }
    return fs.readFileSync(patchPath, 'utf8');
  }
  // Read from stdin if no file argument — useful for piping the output
  // of `git diff main..HEAD` directly into the CLI.
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return '(no hits)';
  const rows = hits.map((h) => ({
    rule: `${h.source}:${h.rule_id}`,
    score: h.score.toFixed(3),
    title: h.title,
  }));
  const ruleWidth = Math.max(8, ...rows.map((r) => r.rule.length));
  const scoreWidth = Math.max(5, ...rows.map((r) => r.score.length));
  const header = `${'rule'.padEnd(ruleWidth)}  ${'score'.padEnd(scoreWidth)}  title`;
  const sep = `${'-'.repeat(ruleWidth)}  ${'-'.repeat(scoreWidth)}  -----`;
  const body = rows
    .map((r) => `${r.rule.padEnd(ruleWidth)}  ${r.score.padEnd(scoreWidth)}  ${r.title}`)
    .join('\n');
  return `${header}\n${sep}\n${body}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const diff = await readDiff(args.patchPath);
  if (!diff.trim()) {
    throw new Error('No diff text provided (file is empty or stdin had no content).');
  }

  const logger = new Logger('query:rules');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const embeddings = app.get(EmbeddingsService);
    const hits = await embeddings.search(diff, { k: args.k });
    // eslint-disable-next-line no-console
    console.log(formatHits(hits));
    logger.log(`returned ${hits.length} hits for k=${args.k}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('query:rules failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
