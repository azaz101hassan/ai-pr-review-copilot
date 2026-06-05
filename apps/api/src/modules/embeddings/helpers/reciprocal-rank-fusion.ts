// Reciprocal Rank Fusion — merge several independent ranked lists into
// one consensus ranking. Each list contributes `1 / (kFusion + rank)`
// per appearance; items appearing in multiple lists accumulate, which
// is exactly the signal we want for hybrid retrieval (a chunk that
// scores well under BOTH dense embeddings AND BM25 keywords is a
// stronger candidate than one that scores well under only one).
//
// `kFusion = 60` is the value Cormack et al. (2009) introduced and the
// number most modern retrieval stacks still default to. The constant
// damps the high-rank contribution: ranks 1 and 2 differ by less than
// ranks 11 and 12 in raw form, but kFusion = 60 makes those two
// distances comparable, so the merge isn't dominated by whichever list
// happened to rank a candidate #1.

const DEFAULT_K_FUSION = 60;

export interface MergeInputHit {
  id: string;
  // Optional explicit rank for this hit within its source list. When
  // present, RRF uses this number directly; when absent, the hit's
  // 1-indexed position in the list is used as its rank.
  //
  // Set this when the source list has many ties at the same rank — for
  // example, a sparse-retrieval pass where every chunk that was top-1
  // for ANY query token has the same logical rank. Encoding the tie in
  // the list position forces RRF to give later-inserted items worse
  // ranks; passing `rank` explicitly fixes the tie at its true value.
  rank?: number;
}

export interface FusedHit {
  id: string;
  rrfScore: number;
}

export interface RrfOptions {
  // The final number of unique items to return. The merge runs over
  // every item in every input list; this only trims the tail.
  finalK: number;
  // Override the RRF constant. Don't unless you've read Cormack —
  // changing this is what tuning the merge feels like.
  kFusion?: number;
}

export function rrfMerge<H extends MergeInputHit>(
  lists: H[][],
  options: RrfOptions,
): FusedHit[] {
  const kFusion = options.kFusion ?? DEFAULT_K_FUSION;
  const finalK = options.finalK;
  if (finalK <= 0) return [];

  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let idx = 0; idx < list.length; idx++) {
      const hit = list[idx];
      const rank = hit.rank ?? idx + 1;
      const inc = 1 / (kFusion + rank);
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + inc);
    }
  }

  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, finalK);
}
