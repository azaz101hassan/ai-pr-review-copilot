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
import { FilesystemRepoContextProvider } from '@/infrastructure/repo-context';

// npm sets INIT_CWD to the directory the user actually ran the command
// from. We need this because `npm run … --workspace apps/api` shifts
// CWD into apps/api/ before the script starts — without INIT_CWD,
// `apps/api/test/fixtures/…` from the repo root would resolve to
// `apps/api/apps/api/test/fixtures/…` (silent path explosion).
const INVOCATION_CWD = process.env.INIT_CWD || process.cwd();

export interface ParsedArgs {
  patchPath: string | undefined;
  k: number | undefined;
  repoDir: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    patchPath: undefined,
    k: undefined,
    repoDir: undefined,
  };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice(4));
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        throw new Error(`--k must be an integer between 1 and 100 (got "${raw}")`);
      }
      args.k = n;
    } else if (raw.startsWith('--repo=')) {
      const value = raw.slice('--repo='.length);
      if (!value) {
        throw new Error('--repo requires a non-empty path (got "--repo=")');
      }
      args.repoDir = value;
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
    'Usage: npm run review:dry-run --workspace apps/api -- <patch-file> [--k=<n>] [--repo=<dir>]\n\n' +
      'Reads diff text from <patch-file> (or stdin if omitted), runs the Claude review\n' +
      'pipeline against the retrieved top-K rules, prints findings + token usage +\n' +
      'estimated cost.\n\n' +
      'With --repo=<dir>, the multi-turn agent loop fetches context\n' +
      '(file content, function definitions, prior reviews) from the given\n' +
      'directory via a FilesystemRepoContextProvider. Without --repo, the\n' +
      "loop runs but every context fetch returns is_error so Claude falls\n" +
      'through to emit_finding on turn 1.\n',
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

// Severity ordering used by the formatter — highest visual priority
// first so reviewers see the most pressing issues at the top.
const SEVERITY_ORDER: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function formatFindings(result: Pick<RunDryRunResult, 'findings'>): string {
  if (result.findings.length === 0) return 'No violations found.';
  const sorted = [...result.findings].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99;
    const sb = SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    const la = a.location_hint ?? '';
    const lb = b.location_hint ?? '';
    return la.localeCompare(lb);
  });

  if (sorted.length === 1) {
    // Day-3 single-finding shape — keep the tabular print so existing
    // smoke procedures still recognise the output.
    return renderTable(sorted);
  }

  // Day-4 multi-finding shape — numbered list grouped visually by
  // severity (the sort above already takes care of grouping).
  return sorted
    .map((f, idx) => {
      const loc = f.location_hint ? ` @ ${f.location_hint}` : '';
      return `${(idx + 1).toString().padStart(2, ' ')}. [${f.severity}] ${f.rule_id}${loc}\n    ${firstLine(f.message)}`;
    })
    .join('\n');
}

function renderTable(rows: Array<{ severity: string; rule_id: string; title: string; message: string }>): string {
  const cells = rows.map((f) => ({
    severity: f.severity,
    rule: f.rule_id,
    title: f.title,
    line: firstLine(f.message),
  }));
  const sevWidth = Math.max(3, ...cells.map((r) => r.severity.length));
  const ruleWidth = Math.max(7, ...cells.map((r) => r.rule.length));
  const titleWidth = Math.max(5, ...cells.map((r) => r.title.length));
  const header = `${'sev'.padEnd(sevWidth)}  ${'rule_id'.padEnd(ruleWidth)}  ${'title'.padEnd(titleWidth)}  message`;
  const sep = `${'-'.repeat(sevWidth)}  ${'-'.repeat(ruleWidth)}  ${'-'.repeat(titleWidth)}  -------`;
  const body = cells
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

function resolveRepoDir(repoDir: string): string {
  const resolved = path.isAbsolute(repoDir)
    ? repoDir
    : path.resolve(INVOCATION_CWD, repoDir);
  if (!fs.existsSync(resolved)) {
    // Fall back to the as-given path so a user who explicitly passes a
    // script-cwd path still wins.
    if (fs.existsSync(repoDir)) return repoDir;
    throw new Error(
      `--repo directory not found: "${repoDir}" (resolved against ${INVOCATION_CWD} as "${resolved}")`,
    );
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`--repo must point to a directory, not a file: "${resolved}"`);
  }
  return resolved;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const diff = await readDiff(args.patchPath);
  if (!diff.trim()) {
    throw new Error('No diff text provided (file is empty or stdin had no content).');
  }

  // Build the repoContext provider before creating the Nest context —
  // surfaces a missing-directory error early without paying the boot
  // cost.
  const repoContext = args.repoDir
    ? new FilesystemRepoContextProvider(resolveRepoDir(args.repoDir))
    : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    // 'log' is included so the per-turn agent-loop traces from
    // AnthropicLlmReviewer surface in the CLI output.
    logger: ['error', 'warn', 'log'],
  });
  try {
    // Per-call half of the resolved-model logging (the startup half
    // lives in ConfigService). Surfaces NODE_ENV misconfig
    // immediately on every dry-run.
    const config = app.get(ConfigService);
    // eslint-disable-next-line no-console
    console.log(
      `[review:dry-run] model: ${config.anthropicModel}${args.repoDir ? ` repo: ${args.repoDir}` : ''}`,
    );

    const reviews = app.get(ReviewsService);
    const result = await reviews.runDryRun({ diff, k: args.k, repoContext });

    // eslint-disable-next-line no-console
    console.log(
      `[review:dry-run] review_id=${result.review_id} prompt=${result.prompt_version} ` +
        `turns=${result.turn_count} ` +
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

// Only call main() when this file is the entry point. When imported
// from a unit test (which exercises `parseArgs` and `formatFindings`
// directly), top-level `main()` would try to read process.argv and
// fail. Standard idiom for dual entry-point/library files.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
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
}
