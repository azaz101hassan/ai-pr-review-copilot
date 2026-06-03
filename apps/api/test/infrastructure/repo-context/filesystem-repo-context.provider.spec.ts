import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilesystemRepoContextProvider } from '@/infrastructure/repo-context/filesystem-repo-context.provider';

describe('FilesystemRepoContextProvider', () => {
  let tmpDir: string;
  let provider: FilesystemRepoContextProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-repo-ctx-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'checkout.js'),
      [
        "import { processPayment } from './payments';",
        '',
        'export function chargeCard(order, opts) {',
        '  if (!order) return null;',
        '  return processPayment(order, opts);',
        '}',
        '',
        'export const refundCard = async (order) => {',
        '  return { refunded: true };',
        '};',
        '',
        'class RetryQueue {',
        '  enqueue(item) {',
        '    return item;',
        '  }',
        '}',
      ].join('\n'),
    );

    provider = new FilesystemRepoContextProvider(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fetchFile', () => {
    it('returns file content for a valid repo-relative path', async () => {
      const result = await provider.fetchFile('src/checkout.js');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toContain('export function chargeCard');
        expect(result.path).toBe('src/checkout.js');
      }
    });

    it('returns not_found when path does not exist', async () => {
      const result = await provider.fetchFile('src/does-not-exist.js');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
        expect(result.message).toBeDefined();
      }
    });

    it('rejects path traversal with invalid_input', async () => {
      const result = await provider.fetchFile('../escape.js');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_input');
      }
    });

    it('rejects absolute paths with invalid_input', async () => {
      const result = await provider.fetchFile('/etc/passwd');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_input');
      }
    });

    it('rejects empty path with invalid_input', async () => {
      const result = await provider.fetchFile('');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_input');
      }
    });

    it('returns not_found when the path resolves to a directory, not a file', async () => {
      const result = await provider.fetchFile('src');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Directory access is structurally different from a missing
        // file, but both should surface as `not_found` from Claude's
        // perspective — neither is a usable file.
        expect(result.reason).toBe('not_found');
      }
    });
  });

  describe('fetchFunctionDefinition', () => {
    it('finds a `function` declaration without a file hint (walks the repo)', async () => {
      const result = await provider.fetchFunctionDefinition('chargeCard');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toContain('function chargeCard(order, opts)');
        expect(result.path).toBe('src/checkout.js');
        expect(result.startLine).toBeGreaterThan(0);
      }
    });

    it('finds a `const` arrow function', async () => {
      const result = await provider.fetchFunctionDefinition('refundCard');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toContain('const refundCard = async');
      }
    });

    it('finds a class method', async () => {
      const result = await provider.fetchFunctionDefinition('enqueue');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toContain('enqueue(item)');
        expect(result.content).toContain('class RetryQueue');
      }
    });

    it('searches only the hinted file when one is given', async () => {
      // Add a decoy in a second file — the hint should restrict search.
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'decoy.js'),
        'function chargeCard() { return "decoy"; }',
      );

      const result = await provider.fetchFunctionDefinition(
        'chargeCard',
        'src/decoy.js',
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe('src/decoy.js');
        expect(result.content).toContain('return "decoy"');
      }
    });

    it('returns not_found when no definition is found', async () => {
      const result = await provider.fetchFunctionDefinition('nonExistent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('returns invalid_input when the hinted file has a traversal pattern', async () => {
      const result = await provider.fetchFunctionDefinition(
        'chargeCard',
        '../escape.js',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_input');
      }
    });

    it('returns invalid_input on empty function name', async () => {
      const result = await provider.fetchFunctionDefinition('');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_input');
      }
    });
  });

  describe('fetchPriorReview', () => {
    it('returns empty array when reviews.json is missing (asymmetric with fetchFile)', async () => {
      // Missing reviews.json is NOT an error — prior-review data is
      // optional context. This asymmetry with fetchFile (missing =
      // error) is documented in the interface.
      const result = await provider.fetchPriorReview({ pr_node_id: 'PR_x' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toEqual([]);
      }
    });

    it('returns matching entries when reviews.json exists', async () => {
      const entries = [
        {
          review_id: 'rev-1',
          finding_id: 'find-1',
          rule_id: 'airbnb:eqeqeq',
          file_path: 'src/checkout.js',
          location_hint: 'src/checkout.js:14',
          dismissed_at: 1700000000000,
          message: 'Use === instead of ==',
        },
        {
          review_id: 'rev-1',
          finding_id: 'find-2',
          rule_id: 'airbnb:no-var',
          file_path: 'src/checkout.js',
          location_hint: 'src/checkout.js:3',
          dismissed_at: null,
          message: 'Replace var with const',
        },
      ];
      fs.writeFileSync(
        path.join(tmpDir, 'reviews.json'),
        JSON.stringify(entries),
      );

      const result = await provider.fetchPriorReview({ pr_node_id: 'PR_123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toHaveLength(2);
        expect(result.content[0].rule_id).toBe('airbnb:eqeqeq');
        expect(result.content[0].dismissed_at).toBe(1700000000000);
        expect(result.content[1].dismissed_at).toBeNull();
      }
    });

    it('filters by file_path when provided', async () => {
      const entries = [
        {
          review_id: 'r',
          finding_id: 'f1',
          rule_id: 'rule-a',
          file_path: 'src/checkout.js',
          location_hint: 'src/checkout.js:1',
          dismissed_at: null,
          message: 'a',
        },
        {
          review_id: 'r',
          finding_id: 'f2',
          rule_id: 'rule-b',
          file_path: 'src/other.js',
          location_hint: 'src/other.js:1',
          dismissed_at: null,
          message: 'b',
        },
      ];
      fs.writeFileSync(
        path.join(tmpDir, 'reviews.json'),
        JSON.stringify(entries),
      );

      const result = await provider.fetchPriorReview({
        file_path: 'src/checkout.js',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toHaveLength(1);
        expect(result.content[0].file_path).toBe('src/checkout.js');
      }
    });

    it('returns parse_error on malformed reviews.json', async () => {
      fs.writeFileSync(path.join(tmpDir, 'reviews.json'), '{not valid json');

      const result = await provider.fetchPriorReview({ pr_node_id: 'PR_x' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('parse_error');
      }
    });

    it('returns parse_error when reviews.json is not an array', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'reviews.json'),
        JSON.stringify({ wrong: 'shape' }),
      );

      const result = await provider.fetchPriorReview({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('parse_error');
      }
    });
  });

  describe('symlink defense (R2)', () => {
    it('rejects an in-tree symlink pointing to a file OUTSIDE repoRoot', async () => {
      // Create a target outside the temp repo dir.
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      const outsidePath = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsidePath, 'top-secret content');

      try {
        // Plant a symlink INSIDE repoDir pointing at the external file.
        fs.symlinkSync(outsidePath, path.join(tmpDir, 'escape-link.txt'));

        const result = await provider.fetchFile('escape-link.txt');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('invalid_input');
          expect(result.message).toMatch(/symlink/i);
        }
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('allows an in-tree symlink that resolves to a file INSIDE repoRoot', async () => {
      // A symlink to a sibling file inside repoDir is fine — the
      // realpath check still falls inside repoRoot.
      fs.symlinkSync(
        path.join(tmpDir, 'src', 'checkout.js'),
        path.join(tmpDir, 'checkout-alias.js'),
      );

      const result = await provider.fetchFile('checkout-alias.js');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toContain('chargeCard');
      }
    });
  });

  describe('file-size cap (R2)', () => {
    it('truncates files larger than MAX_FILE_BYTES with a clear marker', async () => {
      // 80KB > 64KB cap. The provider should return the first 64KB
      // plus a truncation marker mentioning the full size.
      const oversize = 'x'.repeat(80 * 1024);
      fs.writeFileSync(path.join(tmpDir, 'huge.js'), oversize);

      const result = await provider.fetchFile('huge.js');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toMatch(/truncated at \d+ bytes/);
        // First 64KB of x's are still present.
        expect(result.content.startsWith('x'.repeat(1024))).toBe(true);
        // Total length is roughly MAX_FILE_BYTES + the marker line.
        expect(result.content.length).toBeLessThan(80 * 1024);
      }
    });

    it('returns small files untruncated', async () => {
      // Sanity — the existing src/checkout.js fixture is small and
      // shouldn't trip the truncation path.
      const result = await provider.fetchFile('src/checkout.js');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).not.toMatch(/truncated/);
      }
    });
  });

  describe('reason enum coverage', () => {
    it('only ever emits not_found, invalid_input, or parse_error (no GitHub-only reasons)', async () => {
      // Exercise every failure path the filesystem provider can hit
      // and assert no `forbidden | rate_limited | network` ever leaks
      // out. This contract is what lets the GitHub-backed sibling
      // slot in without renegotiating the interface.
      const seenReasons = new Set<string>();
      const collect = (r: { ok: boolean; reason?: string }) => {
        if (!r.ok && r.reason) seenReasons.add(r.reason);
      };

      collect(await provider.fetchFile('does/not/exist'));
      collect(await provider.fetchFile('../escape'));
      collect(await provider.fetchFile(''));
      collect(await provider.fetchFunctionDefinition('nothing'));
      collect(await provider.fetchFunctionDefinition('chargeCard', '../x.js'));
      fs.writeFileSync(path.join(tmpDir, 'reviews.json'), '{bad');
      collect(await provider.fetchPriorReview({}));

      for (const reason of seenReasons) {
        expect(['not_found', 'invalid_input', 'parse_error']).toContain(reason);
      }
    });
  });
});
