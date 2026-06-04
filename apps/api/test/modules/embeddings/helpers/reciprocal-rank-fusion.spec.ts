import { rrfMerge } from '@/modules/embeddings/helpers/reciprocal-rank-fusion';

describe('rrfMerge', () => {
  it('returns an empty array when finalK is zero or negative', () => {
    expect(rrfMerge([[{ id: 'a' }]], { finalK: 0 })).toEqual([]);
    expect(rrfMerge([[{ id: 'a' }]], { finalK: -1 })).toEqual([]);
  });

  it('returns the single input list trimmed to finalK when given one list', () => {
    const merged = rrfMerge([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]], {
      finalK: 2,
    });
    expect(merged.map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('ranks an id present in BOTH lists above an id present in only one', () => {
    const dense = [{ id: 'in-both' }, { id: 'dense-only' }, { id: 'tail' }];
    const sparse = [{ id: 'sparse-only' }, { id: 'in-both' }];

    const merged = rrfMerge([dense, sparse], { finalK: 4 });
    expect(merged[0].id).toBe('in-both');
    // Single-list candidates follow; their relative order depends on
    // rank within their list, but `in-both` is the consensus winner.
    expect(merged.map((h) => h.id)).toContain('dense-only');
    expect(merged.map((h) => h.id)).toContain('sparse-only');
  });

  it('uses kFusion = 60 by default — rank 1 contributes 1/61', () => {
    const merged = rrfMerge([[{ id: 'a' }]], { finalK: 1 });
    // 1 / (60 + 1) = 1/61 ≈ 0.0164
    expect(merged[0].rrfScore).toBeCloseTo(1 / 61, 6);
  });

  it('respects an explicit kFusion override', () => {
    const merged = rrfMerge([[{ id: 'a' }]], { finalK: 1, kFusion: 10 });
    expect(merged[0].rrfScore).toBeCloseTo(1 / 11, 6);
  });

  it('handles empty input lists without throwing', () => {
    expect(rrfMerge([[], []], { finalK: 5 })).toEqual([]);
    expect(rrfMerge([], { finalK: 5 })).toEqual([]);
  });

  it('preserves rank ordering across many lists', () => {
    // Three lists, same item ranked at different positions in each.
    // Sum should still rank the item with the most appearances first.
    const merged = rrfMerge(
      [
        [{ id: 'unanimous' }, { id: 'lone' }],
        [{ id: 'unanimous' }],
        [{ id: 'unanimous' }],
      ],
      { finalK: 5 },
    );
    expect(merged[0].id).toBe('unanimous');
    // unanimous: 3 × 1/61 = 3/61
    expect(merged[0].rrfScore).toBeCloseTo(3 / 61, 6);
    // lone: 1 × 1/62
    expect(merged.find((h) => h.id === 'lone')?.rrfScore).toBeCloseTo(
      1 / 62,
      6,
    );
  });

  it('trims to finalK after sorting, not before', () => {
    // The first list alone has 5 items; the second list adds none. If
    // we (incorrectly) trimmed each list to finalK before merging, the
    // tail would never get to accumulate from the second list.
    const merged = rrfMerge(
      [
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
        [{ id: 'e' }, { id: 'd' }],
      ],
      { finalK: 2 },
    );
    // 'e' is rank 5 in list 1 (1/65) and rank 1 in list 2 (1/61).
    // 'd' is rank 4 in list 1 (1/64) and rank 2 in list 2 (1/62).
    // Both should outrank single-appearance 'a' (1/61).
    const ids = merged.map((h) => h.id);
    expect(ids).toContain('e');
    expect(ids).toContain('d');
  });
});
