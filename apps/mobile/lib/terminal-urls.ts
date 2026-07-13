// Pure URL detection helpers for the terminal. Output chunks are scanned for
// http(s) links (dev servers, auth/login URLs during provider setup) so the UI
// can surface the most recent one in a dismissible banner. Nothing is opened
// automatically — the user taps to open (https only) or copies.

// Match http(s) URLs; stop at whitespace and characters that never appear
// unescaped inside a URL. Trailing punctuation is trimmed separately so a URL
// at the end of a sentence ("...http://x.") does not keep the period.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_JUNK_RE = /[.,;:!?'")\]}>]+$/;

function normalizeUrl(raw: string): string {
  return raw.replace(TRAILING_JUNK_RE, "");
}

/** Extract unique http(s) URLs from text, preserving first-seen order. */
export function extractHttpUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = normalizeUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Merge newly-detected URLs into a bounded recent list (most-recent-last). A
 * re-detected URL moves to the end rather than duplicating; the list is capped
 * so it can never grow without bound.
 */
export function pushRecentUrls(existing: string[], next: string[], cap: number): string[] {
  if (next.length === 0) return existing;
  const merged = existing.slice();
  for (const url of next) {
    const at = merged.indexOf(url);
    if (at !== -1) merged.splice(at, 1);
    merged.push(url);
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** The most recent recent-URL the user has not dismissed, or null. */
export function pickBannerUrl(recent: string[], dismissed: ReadonlySet<string>): string | null {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (!dismissed.has(recent[i])) return recent[i];
  }
  return null;
}

/** Only https URLs may be opened in the browser; http/other schemes copy-only. */
export function isOpenableUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}
