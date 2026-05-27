import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CorpusLoader } from '@/modules/embeddings/helpers/corpus-loader';

describe('CorpusLoader', () => {
  let tmpDir: string;
  let loader: CorpusLoader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-loader-'));
    loader = new CorpusLoader();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, payload: unknown): void {
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(payload), 'utf8');
  }

  it('loads sources and normalizes rules into chunks with body concatenation', () => {
    writeFile('airbnb-rules.json', {
      source: { id: 'airbnb-eslint', name: 'Airbnb ESLint' },
      rules: [
        {
          id: 'eqeqeq',
          severity: 'error',
          language: 'javascript',
          category: 'best-practices',
          title: 'Require === and !==',
          description: 'Always use strict equality to avoid type coercion bugs.',
          examples: { bad: 'if (x == 1)', good: 'if (x === 1)' },
        },
      ],
    });

    const result = loader.load(tmpDir);

    expect(result.sources).toEqual([
      { id: 'airbnb-eslint', name: 'Airbnb ESLint', description: null },
    ]);
    expect(result.chunks).toHaveLength(1);
    const chunk = result.chunks[0];
    expect(chunk.id).toBe('airbnb-eslint:eqeqeq');
    expect(chunk.source_id).toBe('airbnb-eslint');
    expect(chunk.rule_id).toBe('eqeqeq');
    expect(chunk.severity).toBe('error');
    expect(chunk.body).toContain('Require === and !==');
    expect(chunk.body).toContain('Always use strict equality');
    expect(chunk.body).toContain('Bad:\nif (x == 1)');
    expect(chunk.body).toContain('Good:\nif (x === 1)');
  });

  it('reads multiple seed files and merges them', () => {
    writeFile('airbnb-rules.json', {
      source: { id: 'airbnb-eslint', name: 'Airbnb' },
      rules: [
        { id: 'no-var', title: 'No var', description: 'Use let/const.' },
      ],
    });
    writeFile('team-standards.json', {
      source: { id: 'team-standards', name: 'Team Standards' },
      rules: [
        { id: 'env-via-config', title: 'Env via ConfigService', description: 'Never read process.env directly.' },
      ],
    });

    const result = loader.load(tmpDir);

    expect(result.sources.map((s) => s.id).sort()).toEqual([
      'airbnb-eslint',
      'team-standards',
    ]);
    expect(result.chunks.map((c) => c.id).sort()).toEqual([
      'airbnb-eslint:no-var',
      'team-standards:env-via-config',
    ]);
  });

  it('omits the Bad/Good sections when no examples are provided', () => {
    writeFile('airbnb-rules.json', {
      source: { id: 'airbnb-eslint', name: 'Airbnb' },
      rules: [
        { id: 'no-var', title: 'No var', description: 'Use let/const.' },
      ],
    });

    const result = loader.load(tmpDir);
    expect(result.chunks[0].body).toBe('No var\n\nUse let/const.');
    expect(result.chunks[0].body).not.toContain('Bad:');
    expect(result.chunks[0].body).not.toContain('Good:');
  });

  it('throws a clear error when the seeds directory is missing', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(() => loader.load(missing)).toThrow(/seeds directory not found/i);
  });

  it('throws when the directory has no .json files', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'no rules here', 'utf8');
    expect(() => loader.load(tmpDir)).toThrow(/No .json seed files/i);
  });

  it('throws on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{this is not json', 'utf8');
    expect(() => loader.load(tmpDir)).toThrow(/not valid JSON/i);
  });

  it('throws when a file is missing required fields', () => {
    writeFile('bad-shape.json', { source: { id: 'x' } });
    expect(() => loader.load(tmpDir)).toThrow(/missing required fields/i);
  });
});
