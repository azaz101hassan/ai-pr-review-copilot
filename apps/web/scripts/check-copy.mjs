#!/usr/bin/env node
// Reject em-dashes anywhere in the rendered surface.
//
// Em-dashes in UI copy are banned: they read as an AI-prose tell to the
// audience this dashboard targets. The
// EmptyCell helper was fixed in 92d5ad2; ApiFailureAlert immediately
// regressed it in 9c70062 inside a JavaScript template literal, which
// the deterministic detector couldn't catch because the dash sat
// inside backticks rather than between JSX tags.
//
// This script greps the raw bytes of every committed .ts(x) source
// file under apps/web/ for U+2014 (em dash) and reports each hit. It
// skips JSX comments (which are not rendered) but otherwise treats
// every occurrence — string literals, template interpolations, prose
// in JSX text — as a regression.
//
// Hooked into CI by .github/workflows/ci.yml; run locally with
// `npm run check:copy --workspace apps/web`.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['app', 'components', 'lib'];
const EXT = new Set(['.ts', '.tsx']);
const EM_DASH = '—';

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

// Strip line-comments and block-comments before scanning so an em-dash
// inside `/* ... */` or `// ...` doesn't trip the check.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function main() {
  const files = (await Promise.all(SCAN_DIRS.map((d) => walk(path.join(ROOT, d))))).flat();
  const hits = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const scrubbed = stripComments(raw);
    if (!scrubbed.includes(EM_DASH)) continue;
    const lines = scrubbed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(EM_DASH)) {
        hits.push({ file: path.relative(ROOT, file), line: i + 1, text: lines[i].trim() });
      }
    }
  }
  if (hits.length === 0) {
    process.exit(0);
  }
  console.error(`check-copy: ${hits.length} em-dash(es) found in apps/web (non-comment code).`);
  console.error('Em-dashes in UI copy are banned: they read as an AI-prose tell.');
  console.error('Use middle dot ( · ), en-dash (–), or rewrite.');
  console.error('');
  for (const { file, line, text } of hits) {
    console.error(`  ${file}:${line}  ${text}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('check-copy: unexpected error', err);
  process.exit(2);
});
