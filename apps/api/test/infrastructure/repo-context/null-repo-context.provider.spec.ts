import { NullRepoContextProvider } from '@/infrastructure/repo-context/null-repo-context.provider';

describe('NullRepoContextProvider', () => {
  const provider = new NullRepoContextProvider();

  describe('fetchFile', () => {
    it('returns truthful not_found for any path', async () => {
      const result = await provider.fetchFile('src/anything.js');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
        expect(result.message).toMatch(/no repo context/i);
      }
    });
  });

  describe('fetchFunctionDefinition', () => {
    it('returns truthful not_found for any name', async () => {
      const result = await provider.fetchFunctionDefinition('chargeCard');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
        expect(result.message).toMatch(/no repo context/i);
      }
    });
  });

  describe('fetchPriorReview', () => {
    it('returns ok with empty array — "no prior reviews" is the truthful answer, not an error', async () => {
      const result = await provider.fetchPriorReview({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toEqual([]);
      }
    });

    it('returns empty array regardless of query', async () => {
      const result = await provider.fetchPriorReview({
        pr_node_id: 'PR_anything',
        file_path: 'src/x.js',
        rule_id: 'rule-y',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toEqual([]);
      }
    });
  });
});
