export const BROWSER_SAVED_PAGES_KEY = "matrix.desktop.browser.saved-pages.v1";
export const MAX_SAVED_PAGES = 10_000;

export interface SavedBrowserPage {
  title: string;
  url: string;
  folder: string;
}

function normalizePage(value: unknown): SavedBrowserPage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (typeof page.url !== "string" || page.url.length > 2_048) return null;
  if (typeof page.title !== "string" || !page.title.trim() || page.title.length > 256) return null;
  if (typeof page.folder !== "string" || page.folder.length > 512) return null;
  try {
    const url = new URL(page.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return { title: page.title, url: url.toString(), folder: page.folder };
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function mergeSavedPages(existing: SavedBrowserPage[], imported: unknown[]): SavedBrowserPage[] {
  const pages: SavedBrowserPage[] = [];
  const seen = new Set<string>();
  for (const candidate of [...existing, ...imported]) {
    if (pages.length >= MAX_SAVED_PAGES) break;
    const page = normalizePage(candidate);
    if (!page || seen.has(page.url)) continue;
    pages.push(page);
    seen.add(page.url);
  }
  return pages;
}

export function parseSavedPages(raw: string | null): SavedBrowserPage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? mergeSavedPages([], parsed.slice(0, MAX_SAVED_PAGES)) : [];
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}
