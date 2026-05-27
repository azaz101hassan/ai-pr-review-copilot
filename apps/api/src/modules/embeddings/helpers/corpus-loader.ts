import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Each rule in a seed file. The schema is intentionally close to what a
// real ESLint rule + an internal-runbook entry both look like, so the
// embedding signal carries useful semantics — title states the rule,
// description explains it in prose, examples show bad-then-good code.
export interface RawRule {
  id: string;
  severity?: 'error' | 'warning' | 'info';
  language?: 'javascript' | 'typescript' | 'other';
  category?: string;
  title: string;
  description: string;
  examples?: {
    bad?: string;
    good?: string;
  };
}

// Source-level config in a seed file: the source's slug + display name +
// the rules array.
export interface RawCorpusFile {
  source: {
    id: string;
    name: string;
    description?: string;
  };
  rules: RawRule[];
}

// Normalized chunk a downstream embedder/persister can consume. Notice
// `body` is the full concatenation the embedding actually sees — title
// is in there too. That's deliberate: titles are short, high-signal
// strings, and Voyage's code-tuned model picks them up well as the
// chunk's "topic sentence".
export interface NormalizedChunk {
  id: string;
  source_id: string;
  rule_id: string;
  title: string;
  body: string;
  severity?: 'error' | 'warning' | 'info';
  language?: 'javascript' | 'typescript' | 'other';
  category?: string;
}

export interface CorpusSource {
  id: string;
  name: string;
  description: string | null;
}

export interface LoadedCorpus {
  sources: CorpusSource[];
  chunks: NormalizedChunk[];
}

// Two seed files committed to the repo. The runner discovers any
// `.json` file under `apps/api/seeds/`, so adding a third source later
// only requires dropping a new file in.
const DEFAULT_SEEDS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'seeds');

@Injectable()
export class CorpusLoader {
  load(seedsDir = DEFAULT_SEEDS_DIR): LoadedCorpus {
    if (!fs.existsSync(seedsDir)) {
      throw new Error(
        `Seeds directory not found: ${seedsDir}. Did the apps/api/seeds/ files get committed?`,
      );
    }

    const files = fs
      .readdirSync(seedsDir)
      .filter((name) => name.endsWith('.json'))
      .sort();

    if (files.length === 0) {
      throw new Error(
        `No .json seed files under ${seedsDir}. Expected at least airbnb-rules.json and team-standards.json.`,
      );
    }

    const sources: CorpusSource[] = [];
    const chunks: NormalizedChunk[] = [];

    for (const file of files) {
      const fullPath = path.join(seedsDir, file);
      const parsed = this.parseFile(fullPath);
      sources.push({
        id: parsed.source.id,
        name: parsed.source.name,
        description: parsed.source.description ?? null,
      });
      for (const rule of parsed.rules) {
        chunks.push(this.normalize(parsed.source.id, rule));
      }
    }

    return { sources, chunks };
  }

  private parseFile(fullPath: string): RawCorpusFile {
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      throw new Error(
        `Failed to read seed file ${fullPath}: ${describe(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Seed file ${fullPath} is not valid JSON: ${describe(err)}`);
    }
    if (!isRawCorpusFile(parsed)) {
      throw new Error(
        `Seed file ${fullPath} is missing required fields. Expected { source: { id, name, ... }, rules: [...] }.`,
      );
    }
    return parsed;
  }

  private normalize(sourceId: string, rule: RawRule): NormalizedChunk {
    const parts = [rule.title, rule.description];
    if (rule.examples?.bad) parts.push(`Bad:\n${rule.examples.bad}`);
    if (rule.examples?.good) parts.push(`Good:\n${rule.examples.good}`);
    const body = parts.join('\n\n');
    return {
      id: `${sourceId}:${rule.id}`,
      source_id: sourceId,
      rule_id: rule.id,
      title: rule.title,
      body,
      severity: rule.severity,
      language: rule.language,
      category: rule.category,
    };
  }
}

function isRawCorpusFile(v: unknown): v is RawCorpusFile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  const src = obj.source as Record<string, unknown> | undefined;
  if (!src || typeof src.id !== 'string' || typeof src.name !== 'string') return false;
  if (!Array.isArray(obj.rules)) return false;
  return obj.rules.every(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as Record<string, unknown>).id === 'string' &&
      typeof (r as Record<string, unknown>).title === 'string' &&
      typeof (r as Record<string, unknown>).description === 'string',
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
