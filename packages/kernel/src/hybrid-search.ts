export interface RankedResult {
  id: string;
  content: string;
  score: number;
  sourceType?: string;
  sourceId?: string;
}

export interface RRFOptions {
  k?: number;
  limit?: number;
}

export function reciprocalRankFusion(
  rankedLists: RankedResult[][],
  opts?: RRFOptions,
): RankedResult[] {
  const k = opts?.k ?? 60;
  const limit = opts?.limit ?? 20;

  const scores = new Map<string, { result: RankedResult; rrfScore: number }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
      } else {
        scores.set(item.id, { result: item, rrfScore });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.result,
      score: entry.rrfScore,
    }));
}
