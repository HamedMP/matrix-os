/**
 * GitHub source cursor, stored in brain_sync_cursors: "gh1:" + base64url JSON { v, s, p, d, c? }.
 *   s  the listing watermark: every issue and pull request updated before s is applied (GitHub time, seconds)
 *   p  listing page at s (above 1 only while every item on the earlier pages is tied at s and applied)
 *   d  issue numbers already applied whose updated_at is exactly s (at most GITHUB_LIMITS.doneMax)
 *   c  a pull request still open across pages: its number n, its updated_at u, and o children already written
 * Pure. An unreadable cursor is cursor_invalid; the cursor never holds provider text.
 */
import { z } from "zod/v4";
import { BRAIN_CURSOR_MAX_CHARS } from "../../index.js";
import { GITHUB_LIMITS } from "./types.js";

const PREFIX = "gh1:";
const GITHUB_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const CursorSchema = z.strictObject({
  v: z.literal(1),
  s: z.string().regex(GITHUB_TIME).refine((value) => Number.isFinite(Date.parse(value))),
  p: z.number().int().min(1).max(GITHUB_LIMITS.tiePagesMax),
  d: z.array(z.number().int().min(1).max(999_999_999)).max(GITHUB_LIMITS.doneMax),
  c: z.strictObject({
    n: z.number().int().min(1).max(999_999_999), u: z.string().regex(GITHUB_TIME),
    o: z.number().int().min(1).max(2 * GITHUB_LIMITS.childPerPage),
  }).optional(),
});

/** A pull request whose documents did not fit one page: the next page writes its children from `written` on. */
export interface BrainGithubOpenItem {
  readonly number: number;
  readonly updatedAt: string;
  readonly written: number;
}

export interface BrainGithubCursor {
  readonly since: string;
  readonly page: number;
  readonly done: readonly number[];
  readonly open?: BrainGithubOpenItem;
}

export function encodeGithubCursor(cursor: BrainGithubCursor): string {
  const open = cursor.open === undefined ? {} : { c: { n: cursor.open.number, u: cursor.open.updatedAt, o: cursor.open.written } };
  const json = JSON.stringify({ v: 1, s: cursor.since, p: cursor.page, d: cursor.done, ...open });
  return `${PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

/** Null when the text is not a cursor this adapter wrote. */
export function decodeGithubCursor(text: string): BrainGithubCursor | null {
  if (!text.startsWith(PREFIX) || text.length > BRAIN_CURSOR_MAX_CHARS) return null;
  const payload = text.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = CursorSchema.safeParse(value);
  if (!parsed.success) return null;
  const { s: since, p: page, d: done, c: open } = parsed.data;
  return open === undefined ? { since, page, done } : { since, page, done, open: { number: open.n, updatedAt: open.u, written: open.o } };
}
