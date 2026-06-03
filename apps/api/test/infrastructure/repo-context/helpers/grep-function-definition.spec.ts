import { grepFunctionDefinition } from '@/infrastructure/repo-context/helpers/grep-function-definition';

describe('grepFunctionDefinition', () => {
  describe('happy paths — three matched forms', () => {
    it('matches a top-level function declaration', () => {
      const src = [
        "import { foo } from './lib';",
        '',
        'function chargeCard(order, opts) {',
        '  if (!order) return;',
        '  return processPayment(order);',
        '}',
        '',
        'export default chargeCard;',
      ].join('\n');

      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('function chargeCard(order, opts)');
      // Surrounding context — 10 lines around the match — so we expect
      // the import block above and the export below to be visible.
      expect(result!.content).toContain("import { foo } from './lib';");
      expect(result!.startLine).toBeGreaterThan(0);
      expect(result!.endLine).toBeGreaterThanOrEqual(result!.startLine);
    });

    it('matches `export function` variant', () => {
      const src = 'export function chargeCard(order) {\n  return true;\n}';
      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('export function chargeCard(order)');
    });

    it('matches `export async function` variant', () => {
      const src = 'export async function chargeCard(order) {\n  return true;\n}';
      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('export async function chargeCard');
    });

    it('matches a const arrow assignment', () => {
      const src = [
        'const chargeCard = async (order) => {',
        '  await fetch(order);',
        '};',
      ].join('\n');

      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('const chargeCard = async (order)');
    });

    it('matches a let assignment', () => {
      const src = "let chargeCard = function () { return 'ok'; };";
      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('let chargeCard =');
    });

    it('matches an `export const` arrow assignment', () => {
      const src = 'export const chargeCard = (order) => order.id;';
      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('export const chargeCard');
    });

    it('matches a class method', () => {
      const src = [
        'class Checkout {',
        '  constructor() {',
        '    this.x = 1;',
        '  }',
        '',
        '  chargeCard(order) {',
        '    return this.x;',
        '  }',
        '}',
      ].join('\n');

      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('chargeCard(order)');
      // Should also include the `class Checkout` line in surrounding context.
      expect(result!.content).toContain('class Checkout');
    });
  });

  describe('miss paths', () => {
    it('returns null when the name is not in the source', () => {
      const src = 'function processPayment() {}';
      expect(grepFunctionDefinition('chargeCard', src)).toBeNull();
    });

    it('returns null on empty source', () => {
      expect(grepFunctionDefinition('chargeCard', '')).toBeNull();
    });

    it('does not match a substring of a longer name', () => {
      // "charge" should not match "chargeCard".
      const src = 'function chargeCard() {}';
      expect(grepFunctionDefinition('charge', src)).toBeNull();
    });

    it('does not match a function call site (only definitions)', () => {
      // A bare call like `chargeCard(order)` outside a class body
      // should NOT be considered a definition. The class-method
      // pattern requires the `class` block ancestor; in flat code, no
      // pattern should match.
      const src = [
        'function processOrder(order) {',
        '  chargeCard(order);',
        '}',
      ].join('\n');
      expect(grepFunctionDefinition('chargeCard', src)).toBeNull();
    });
  });

  describe('documented limitations', () => {
    it('class-method pattern returns the FIRST match when two classes define the same method name', () => {
      // Documented limitation: with two classes defining a method of
      // the same name, the heuristic returns the first hit. Users
      // get truthful "this is what we found" content; a full AST
      // upgrade is out of scope for the heuristic.
      const src = [
        'class A {',
        '  process() {',
        '    return 1;',
        '  }',
        '}',
        '',
        'class B {',
        '  process() {',
        '    return 2;',
        '  }',
        '}',
      ].join('\n');

      const result = grepFunctionDefinition('process', src);
      expect(result).not.toBeNull();
      // The first class's method body wins — surrounding context shows
      // `class A` not `class B`.
      expect(result!.content).toContain('class A');
      expect(result!.content).toContain('return 1');
    });

    it('surrounding-context window is bounded (≤ 21 lines: 10 before + match line + 10 after)', () => {
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) lines.push(`// line ${i}`);
      lines.push('function chargeCard() {}');
      for (let i = 0; i < 100; i++) lines.push(`// trailing ${i}`);
      const src = lines.join('\n');

      const result = grepFunctionDefinition('chargeCard', src);
      expect(result).not.toBeNull();
      const returnedLineCount = result!.content.split('\n').length;
      expect(returnedLineCount).toBeLessThanOrEqual(21);
    });
  });

  describe('regex safety', () => {
    it('escapes special regex characters in the function name', () => {
      // A pathological name containing regex metacharacters must not
      // crash or false-match. `$foo` is a valid JS identifier; ensure
      // we treat it literally.
      const src = 'function $foo() {}';
      const result = grepFunctionDefinition('$foo', src);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('function $foo()');
    });
  });
});
