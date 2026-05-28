import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  IRepoContextProvider,
  PriorReviewEntry,
  PriorReviewQuery,
  RepoFileResult,
  RepoFunctionResult,
  RepoPriorReviewResult,
} from '@/modules/reviews/types/repo-context-provider';
import { grepFunctionDefinition } from './helpers/grep-function-definition';

// Per-file byte cap. Anthropic bills cumulative input tokens across
// every turn, and a 10MB minified bundle returned through
// fetch_related_file would replay in every subsequent turn's
// messages[] body — a single misconfigured --repo flag could produce
// a $100+ review. 64KB is a generous ceiling for any plausible
// source file Claude needs to reason about; oversized reads return a
// truncation marker so the agent knows the content was clipped.
const MAX_FILE_BYTES = 64 * 1024;

// Recursive walk bounds for fetchFunctionDefinition without a file
// hint. Symlink cycles, accidental `--repo=/` invocations, or
// pathologically deep fixture trees all reduce to "infinite walk";
// we cap both file count and depth so a misconfigured CLI fails
// predictably instead of hanging.
const MAX_WALK_FILES = 10_000;
const MAX_WALK_DEPTH = 12;

// Filesystem-backed repo-context provider. Constructed with the
// absolute path to a `<fixture>.repo/` directory; all method inputs
// are resolved against that root and rejected if they escape it
// (path traversal → `invalid_input`).
//
// Day-4 invariant: only emits `not_found`, `invalid_input`, or
// `parse_error`. The wider error vocabulary
// (`forbidden | rate_limited | network`) is reserved for Day-5's
// GitHub sibling. A unit test enforces this contract.
export class FilesystemRepoContextProvider implements IRepoContextProvider {
  private readonly repoRoot: string;

  constructor(repoDir: string) {
    this.repoRoot = path.resolve(repoDir);
  }

  async fetchFile(filePath: string): Promise<RepoFileResult> {
    const resolved = await this.resolveSafeWithSymlinkCheck(filePath);
    if (!resolved.ok) return resolved;

    try {
      const stat = await fs.stat(resolved.absPath);
      if (!stat.isFile()) {
        return {
          ok: false,
          reason: 'not_found',
          message: `path is not a file: ${filePath}`,
        };
      }
      // Cap per-file bytes. Read up to MAX_FILE_BYTES; if the file is
      // larger, surface a truncation marker so Claude knows the
      // content was clipped (the partial content still helps the
      // agent reason, but it shouldn't assume completeness).
      let content: string;
      if (stat.size > MAX_FILE_BYTES) {
        const handle = await fs.open(resolved.absPath, 'r');
        try {
          const buf = Buffer.alloc(MAX_FILE_BYTES);
          const { bytesRead } = await handle.read(buf, 0, MAX_FILE_BYTES, 0);
          content =
            buf.slice(0, bytesRead).toString('utf8') +
            `\n\n[... truncated at ${MAX_FILE_BYTES} bytes; full file is ${stat.size} bytes ...]`;
        } finally {
          await handle.close();
        }
      } else {
        content = await fs.readFile(resolved.absPath, 'utf8');
      }
      return { ok: true, content, path: filePath };
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return {
          ok: false,
          reason: 'not_found',
          message: `file not found: ${filePath}`,
        };
      }
      // Anything else (permission errors on the local fs, etc.) maps
      // to `not_found` from Claude's perspective — the filesystem
      // provider doesn't surface `forbidden`, which is Day-5 territory.
      return {
        ok: false,
        reason: 'not_found',
        message: `unable to read file: ${filePath}`,
      };
    }
  }

  async fetchFunctionDefinition(
    name: string,
    file?: string,
  ): Promise<RepoFunctionResult> {
    if (!name || typeof name !== 'string') {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'function name is required',
      };
    }

    // Hinted file → search only that file.
    if (file) {
      const resolved = await this.resolveSafeWithSymlinkCheck(file);
      if (!resolved.ok) return resolved;
      return this.searchSingleFile(name, file, resolved.absPath);
    }

    // No hint → walk the repo for any `.js` / `.ts` / `.jsx` / `.tsx`
    // file. First hit wins (documented limitation).
    const candidates = await this.walkSourceFiles(this.repoRoot);
    for (const abs of candidates) {
      const rel = path.relative(this.repoRoot, abs);
      const hit = await this.searchSingleFile(name, rel, abs);
      if (hit.ok) return hit;
    }
    return {
      ok: false,
      reason: 'not_found',
      message: `function definition not found: ${name}`,
    };
  }

  async fetchPriorReview(
    query: PriorReviewQuery,
  ): Promise<RepoPriorReviewResult> {
    const reviewsPath = path.join(this.repoRoot, 'reviews.json');
    let raw: string;
    try {
      raw = await fs.readFile(reviewsPath, 'utf8');
    } catch (err: unknown) {
      if (isEnoent(err)) {
        // Asymmetric with fetchFile: missing prior-review data is
        // optional context, not an error.
        return { ok: true, content: [] };
      }
      return {
        ok: false,
        reason: 'parse_error',
        message: 'unable to read reviews.json',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        reason: 'parse_error',
        message: 'reviews.json is not valid JSON',
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        reason: 'parse_error',
        message: 'reviews.json must be an array of PriorReviewEntry',
      };
    }

    const entries = parsed as PriorReviewEntry[];
    const filtered = entries.filter((entry) => {
      if (query.file_path && entry.file_path !== query.file_path) return false;
      if (query.rule_id && entry.rule_id !== query.rule_id) return false;
      // `pr_node_id` is not stored on entries (Day-4 fixtures
      // pre-scope to the PR being reviewed); accept it as a no-op
      // filter so callers can pass it through harmlessly.
      return true;
    });

    return { ok: true, content: filtered };
  }

  private resolveSafe(
    relPath: string,
  ):
    | { ok: true; absPath: string }
    | { ok: false; reason: 'invalid_input'; message: string } {
    if (!relPath || typeof relPath !== 'string') {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'path is required',
      };
    }
    if (path.isAbsolute(relPath)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'absolute paths are not allowed',
      };
    }
    const absPath = path.resolve(this.repoRoot, relPath);
    const rel = path.relative(this.repoRoot, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: `path traversal not allowed: ${relPath}`,
      };
    }
    return { ok: true, absPath };
  }

  // Lexical resolveSafe + a realpath check that defends against
  // symlinks inside `repoRoot` pointing to files outside of it.
  // `path.resolve` only collapses `..` segments; it does NOT follow
  // symlinks. A symlinked file under repoDir would pass the lexical
  // check and `fs.readFile` would happily follow the link, leaking
  // arbitrary file content back to Claude through `emit_finding.citation`.
  // We `fs.realpath` the resolved path AND `fs.realpath(repoRoot)`,
  // then re-run the containment check on the canonical pair.
  private async resolveSafeWithSymlinkCheck(
    relPath: string,
  ): Promise<
    | { ok: true; absPath: string }
    | { ok: false; reason: 'invalid_input' | 'not_found'; message: string }
  > {
    const resolved = this.resolveSafe(relPath);
    if (!resolved.ok) return resolved;
    try {
      const realPath = await fs.realpath(resolved.absPath);
      const realRoot = await fs.realpath(this.repoRoot);
      const rel = path.relative(realRoot, realPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          ok: false,
          reason: 'invalid_input',
          message: `path traversal via symlink not allowed: ${relPath}`,
        };
      }
      return { ok: true, absPath: realPath };
    } catch (err: unknown) {
      // realpath throws ENOENT when the target is missing — defer to
      // the caller's not_found handling rather than upgrading to
      // invalid_input. Anything else (EACCES on a directory in the
      // chain, etc.) maps to not_found from Claude's perspective.
      if (isEnoent(err)) {
        return {
          ok: false,
          reason: 'not_found',
          message: `file not found: ${relPath}`,
        };
      }
      return {
        ok: false,
        reason: 'not_found',
        message: `unable to resolve path: ${relPath}`,
      };
    }
  }

  private async searchSingleFile(
    name: string,
    relPath: string,
    absPath: string,
  ): Promise<RepoFunctionResult> {
    let source: string;
    try {
      source = await fs.readFile(absPath, 'utf8');
    } catch {
      return {
        ok: false,
        reason: 'not_found',
        message: `file not found: ${relPath}`,
      };
    }
    const match = grepFunctionDefinition(name, source);
    if (!match) {
      return {
        ok: false,
        reason: 'not_found',
        message: `function definition not found in ${relPath}: ${name}`,
      };
    }
    return {
      ok: true,
      content: match.content,
      path: relPath,
      startLine: match.startLine,
      endLine: match.endLine,
    };
  }

  private async walkSourceFiles(rootDir: string): Promise<string[]> {
    const out: string[] = [];
    const sourceExts = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
    const visitedInodes = new Set<string>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= MAX_WALK_FILES) return;
      if (depth > MAX_WALK_DEPTH) return;
      let entries: Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
        isSymbolicLink: () => boolean;
      }>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_WALK_FILES) return;
        const full = path.join(dir, entry.name);
        // Skip symlinks entirely on directory descent — they're the
        // primary symlink-cycle vector. Symlinked files inside the
        // tree still get found via the file branch below, but only
        // after the realpath containment check in
        // `resolveSafeWithSymlinkCheck` (applied when the agent
        // actually fetches them). Walking through symlinks would
        // duplicate work and risk cycles.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
          }
          // Cycle guard — refuse to re-descend an already-visited
          // inode. Mostly defensive; we already skip symlinks.
          try {
            const stat = await fs.stat(full);
            const inodeKey = `${stat.dev}:${stat.ino}`;
            if (visitedInodes.has(inodeKey)) continue;
            visitedInodes.add(inodeKey);
          } catch {
            continue;
          }
          await walk(full, depth + 1);
        } else if (entry.isFile() && sourceExts.has(path.extname(entry.name))) {
          out.push(full);
        }
      }
    };
    await walk(rootDir, 0);
    // Stable ordering — sort so "first hit wins" is deterministic.
    out.sort();
    return out;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
