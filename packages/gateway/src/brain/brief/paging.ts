/**
 * Offset paging over a list computed on demand. The cursor is base64url JSON { v: 1, k, o }: k fingerprints the
 * endpoint and its filters, so a cursor from another query is invalid_request, and o is the next offset.
 */
import { createHash } from "node:crypto";
import { BrainApiError } from "../api/types.js";
import { BRAIN_FEATURE_CURSOR_MAX_CHARS, type BrainCursorPage } from "../contracts.js";

/** Exactly what pageOf encodes; anything else is invalid_request. */
const CURSOR_JSON = /^\{"v":1,"k":"([a-f0-9]{16})","o":([1-9][0-9]{0,6})\}$/;

export function queryFingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function decodeOffset(cursor: string, key: string): number {
  const valid = cursor.length <= BRAIN_FEATURE_CURSOR_MAX_CHARS && /^[A-Za-z0-9_-]+$/.test(cursor);
  const parts = valid ? CURSOR_JSON.exec(Buffer.from(cursor, "base64url").toString("utf8")) : null;
  if (parts === null || parts[1] !== key) throw new BrainApiError("invalid_request");
  return Number(parts[2]);
}

/** One page of `items`; nextCursor is null on the last page. */
export function pageOf<T>(
  items: readonly T[], limit: number, cursor: string | undefined, key: string,
): BrainCursorPage<T> {
  const offset = cursor === undefined ? 0 : decodeOffset(cursor, key);
  const end = offset + limit;
  const nextCursor = end < items.length
    ? Buffer.from(JSON.stringify({ v: 1, k: key, o: end }), "utf8").toString("base64url") : null;
  return { items: items.slice(offset, end), nextCursor };
}
