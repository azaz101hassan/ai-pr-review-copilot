// Dev CLI for ad-hoc Claude review —
// `npm run review:dry-run --workspace apps/api -- <patch-file>`.
//
// Reads the diff from the file path passed as argv[2] (or stdin if no
// arg), calls ReviewsService.runDryRun, prints findings + token usage +
// estimated cost, exits with status 1 on error.

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@/config';
import { ReviewsService, RunDryRunResult } from '@/modules/reviews';
import { AppModule } from '@/app.module';
import { estimateCost } from '@/modules/reviews/helpers/estimate-cost';

// npm sets INIT_CWD to the directory the user actually ran the command
// from. We need this because `npm run … --workspace apps/api` shifts
// CWD into apps/api/ before the script starts — without INIT_CWD,
// `apps/api/test/fixtures/…` from the repo root would resolve to
// `apps/api/apps/api/test/fixtures/…` (silent path explosion).
const INVOCATION_CWD = process.env.INIT_CWD || process.cwd();

interface ParsedArgs {
  patchPath: string | undefined;
  k: number | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { patchPath: undefined, k: undefined };
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
    'Usage: npm run review:dry-run --workspace apps/api -- <patch-file> [--k=<n>]\n\n' +
      'Reads diff text from <patch-file> (or stdin if omitted), runs the Claude review\n' +
      'pipeline against the retrieved top-K rules, prints findings + token usage +\n' +
      'estimated cost.\n',
  );
}

async function readDiff(patchPath: string | undefined): Promise<string> {
  if (patchPath) {
    // Resolve relative paths against the user's invocation cwd
    // (INIT_CWD), not the script's cwd. Absolute paths pass through
    // unchanged. Try the resolved path first; if that misses, fall back
    // to the as-given path so a user who explicitly passes a script-cwd
    // path still wins.
    const resolved = path.isAbsolute(patchPath)
      ? patchPath
      : path.resolve(INVOCATION_CWD, patchPath);
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved, 'utf8');
    if (fs.existsSync(patchPath)) return fs.readFileSync(patchPath, 'utf8');
    throw new Error(
      `Patch file not found: "${patchPath}" (resolved against ${INVOCATION_CWD} as "${resolved}")`,
    );
  }
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function formatFindings(result: RunDryRunResult): string {
  if (result.findings.length === 0) return 'No violations found.';
  const rows = result.findings.map((f) => ({
    severity: f.severity,
    rule: f.rule_id,
    title: f.title,
    line: firstLine(f.message),
  }));
  const sevWidth = Math.max(3, ...rows.map((r) => r.severity.length));
  const ruleWidth = Math.max(7, ...rows.map((r) => r.rule.length));
  const titleWidth = Math.max(5, ...rows.map((r) => r.title.length));
  const header = `${'sev'.padEnd(sevWidth)}  ${'rule_id'.padEnd(ruleWidth)}  ${'title'.padEnd(titleWidth)}  message`;
  const sep = `${'-'.repeat(sevWidth)}  ${'-'.repeat(ruleWidth)}  ${'-'.repeat(titleWidth)}  -------`;
  const body = rows
    .map(
      (r) =>
        `${r.severity.padEnd(sevWidth)}  ${r.rule.padEnd(ruleWidth)}  ${r.title.padEnd(titleWidth)}  ${r.line}`,
    )
    .join('\n');
  return `${header}\n${sep}\n${body}`;
}

function firstLine(s: string): string {
  return s.split('\n')[0];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const diff = await readDiff(args.patchPath);
  if (!diff.trim()) {
    throw new Error('No diff text provided (file is empty or stdin had no content).');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    // Per-call half of the resolved-model logging (the startup half
    // lives in ConfigService). Surfaces NODE_ENV misconfig
    // immediately on every dry-run.
    const config = app.get(ConfigService);
    // eslint-disable-next-line no-console
    console.log(`[review:dry-run] model: ${config.anthropicModel}`);

    const reviews = app.get(ReviewsService);
    const result = await reviews.runDryRun({ diff, k: args.k });

    // eslint-disable-next-line no-console
    console.log(
      `[review:dry-run] review_id=${result.review_id} prompt=${result.prompt_version} ` +
        `tokens(in/out)=${result.usage?.input_tokens ?? 0}/${result.usage?.output_tokens ?? 0} ` +
        `cache(read/write)=${result.usage?.cache_read_input_tokens ?? 0}/${result.usage?.cache_creation_input_tokens ?? 0}`,
    );
    // eslint-disable-next-line no-console
    console.log(formatFindings(result));

    if (result.usage) {
      const est = estimateCost(result.usage, result.model);
      // eslint-disable-next-line no-console
      console.log(
        `[review:dry-run] estimated cost: $${est.totalUsd.toFixed(4)} ` +
          `(input ${result.usage.input_tokens} / output ${result.usage.output_tokens} tokens, model ${result.model})`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // Scrub discipline: log the error's name + code, never the diff
  // body, rules, or API key.
  const errType = err instanceof Error ? err.name : typeof err;
  const errCode = (err as { errorCode?: string; status?: number })?.errorCode;
  const status = (err as { status?: number })?.status;
  // eslint-disable-next-line no-console
  console.error(
    `review:dry-run failed: ${errType}${status !== undefined ? ` (HTTP ${status})` : ''}${errCode ? ` [${errCode}]` : ''}: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
});
