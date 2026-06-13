// Fuzzy file ranking for quick-open (FR-042, US6). Paths are only ever echoed
// from server responses — this module ranks, it never composes filesystem
// paths.

const SEGMENT_BOUNDARIES = new Set(["/", "-", "_", ".", " "]);

export interface FileHit {
  path: string;
  name: string;
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

const BASENAME_BONUS = 10;

// Greedy subsequence walk over `text` with position-aware bonuses: consecutive
// runs, segment starts, exact-case matches, and a word-completion bonus when
// the match ends at a segment boundary. Returns 0 if `query` is not a
// subsequence of `text`.
function walk(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  let lastMatch = -1;

  for (let ti = 0; ti < text.length && qi < q.length; ti += 1) {
    if (t[ti] !== q[qi]) continue;
    let charScore = 1;
    if (ti === prevMatch + 1) charScore += 3;
    if (ti === 0 || SEGMENT_BOUNDARIES.has(text[ti - 1] ?? "")) charScore += 4;
    if (text[ti] === query[qi]) charScore += 1;
    score += charScore;
    prevMatch = ti;
    lastMatch = ti;
    qi += 1;
  }

  if (qi < q.length) return 0;
  const after = lastMatch + 1;
  if (after >= text.length || SEGMENT_BOUNDARIES.has(text[after] ?? "")) score += 3;
  return score;
}

// A match aligned inside the basename (e.g. "chat" -> "src/lib/chat.ts")
// should outrank one a greedy full-path walk scatters across directories, so
// the basename walk gets a strong bonus and we take the better of the two.
export function fuzzyScore(query: string, candidate: string): number {
  if (query.length === 0 || candidate.length === 0) return 0;
  if (query.length > candidate.length) return 0;

  const fullScore = walk(query, candidate);
  if (fullScore === 0) return 0;

  const basename = basenameOf(candidate);
  const baseScore = walk(query, basename);
  return baseScore > 0 ? Math.max(fullScore, baseScore + BASENAME_BONUS) : fullScore;
}

export function rankFiles(query: string, paths: string[], limit = 50): FileHit[] {
  if (limit <= 0) return [];
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return paths.slice(0, limit).map((path) => ({ path, name: basenameOf(path) }));
  }

  const scored: Array<{ path: string; name: string; score: number }> = [];
  for (const path of paths) {
    const score = fuzzyScore(trimmed, path);
    if (score > 0) scored.push({ path, name: basenameOf(path), score });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, limit).map(({ path, name }) => ({ path, name }));
}
