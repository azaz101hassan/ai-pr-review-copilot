// Heuristic function-definition finder for the Day-4 agent loop.
//
// Three regex patterns are matched in order; the first hit wins:
//   1. `function <name>(`   (optionally `export` / `export async` /
//      `async`-prefixed)
//   2. `const|let|var <name> = ...`   (optionally `export`-prefixed)
//   3. `<name>(` indented inside a `class <Name> { ... }` body
//      (covers class methods)
//
// Returns the matched block plus up to 10 lines of context on each
// side (≤ 21 lines total). Documented limitations live in
// `docs/setup/claude.md` — TypeScript overloads, decorated methods,
// default-exported function expressions, and methods of the same
// name across multiple classes all reduce to "first hit wins".

const CONTEXT_LINES = 10;

function escapeRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface GrepMatch {
  content: string;
  startLine: number; // 1-indexed line number of the first returned line
  endLine: number; // 1-indexed line number of the last returned line
  matchedLine: number; // 1-indexed line number of the actual match
}

export function grepFunctionDefinition(
  name: string,
  source: string,
): GrepMatch | null {
  if (!source || !name) return null;

  const safe = escapeRegex(name);
  const lines = source.split('\n');

  // Patterns 1 & 2 — flat-scope matches. Anchored to start-of-line
  // (with optional leading whitespace).
  const fnDecl = new RegExp(
    `^\\s*(export\\s+)?(async\\s+)?function\\s+${safe}\\b`,
  );
  const varAssign = new RegExp(
    `^\\s*(export\\s+)?(const|let|var)\\s+${safe}\\s*=`,
  );

  // Pattern 3 — class method. Requires being inside a `class X { ... }`
  // body. We track depth via brace counting; a match for
  // `^\s+<name>(` is only accepted when depth > 0 and we last entered
  // a `class` block.
  const classOpen = /^\s*(export\s+)?(abstract\s+)?class\s+\w+/;
  const methodMatch = new RegExp(`^\\s+${safe}\\s*\\(`);

  // Scan once, prioritizing patterns 1 & 2 over pattern 3 only when
  // they tie — but the spec says "first hit wins", so we walk the
  // file top-to-bottom and accept the first matching line of any
  // pattern.

  let inClassDepth = 0; // depth >= 1 when inside a class body
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect a class-block opening on this line. We accept the
    // opening even if `{` is on the same line; the brace counter
    // below handles depth.
    const opensClass = classOpen.test(line);

    if (fnDecl.test(line) || varAssign.test(line)) {
      return assembleMatch(lines, i);
    }

    // Class-method pattern: only valid when we're already inside a
    // class body (depth > 0 AND inClassDepth > 0).
    if (inClassDepth > 0 && methodMatch.test(line)) {
      return assembleMatch(lines, i);
    }

    // Update brace counters AFTER pattern checks so an opening class
    // line's `{` doesn't accidentally mark the same-line method as
    // inside-class (no method can be defined on the class-opening
    // line). Count braces character-by-character; ignore those inside
    // string literals only crudely — this is a heuristic, not a
    // parser.
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    const prevDepth = braceDepth;
    braceDepth += opens - closes;

    if (opensClass && opens > 0) {
      // Entering a class scope.
      inClassDepth++;
    } else if (
      inClassDepth > 0 &&
      braceDepth < prevDepth &&
      braceDepth < inClassDepth
    ) {
      // Exited the class scope.
      inClassDepth = Math.max(0, inClassDepth - 1);
    }
  }

  return null;
}

function assembleMatch(lines: string[], matchedIdx: number): GrepMatch {
  const start = Math.max(0, matchedIdx - CONTEXT_LINES);
  const end = Math.min(lines.length - 1, matchedIdx + CONTEXT_LINES);
  const content = lines.slice(start, end + 1).join('\n');
  return {
    content,
    startLine: start + 1,
    endLine: end + 1,
    matchedLine: matchedIdx + 1,
  };
}
