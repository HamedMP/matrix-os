/**
 * Connector sources: pure helpers shared by every connector adapter. Stable document ids, one-line titles, bodies cut
 * to the store limit, canonical permalinks, person keys, bounded ref sets and versioned cursors.
 */
import { createHash } from "node:crypto";
import type { z } from "zod/v4";
import { BRAIN_DOCUMENT_ID_VERSIONS, BRAIN_PERSON_KEY_PATTERN, BRAIN_REFS_PER_KIND_MAX, type BrainRefKind } from "../../contracts.js";
import {
  BRAIN_CURSOR_MAX_CHARS, BRAIN_DOCUMENT_MAX_BYTES, BRAIN_DOCUMENT_REFS_MAX, BRAIN_PERMALINK_MAX_CHARS,
  BRAIN_REF_VALUE_MAX_BYTES, BRAIN_TITLE_MAX_CHARS, type BrainDocumentRef,
} from "../../types.js";
// sanitizeText: Postgres refuses U+0000 in TEXT.
import { clampTitle as clampGitTitle, sanitizeText as sanitize, truncateUtf8, utf8ByteLength } from "../../git/documents.js";
import type { BrainConnectorKind } from "./types.js";

export const CONNECTOR_TRUNCATION_MARKER = "\n[truncated]";

/** sha256(JSON.stringify([version, externalRef, ...tail])): never of content. */
export function connectorDocumentId(
  kind: BrainConnectorKind, externalRef: string, tail: readonly (string | number)[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([BRAIN_DOCUMENT_ID_VERSIONS[kind], externalRef, ...tail]), "utf8")
    .digest("hex");
}

export function shortHash(parts: readonly string[], length = 32): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, length);
}

/** One line of at most maxChars UTF-16 units (git adapter rules); `fallback` when empty. */
export function clampTitle(raw: string | null | undefined, fallback: string, maxChars = BRAIN_TITLE_MAX_CHARS): string {
  return clampGitTitle(raw ?? "", fallback, maxChars);
}

/**
 * main, a blank line, then the footer lines. main is cut with a marker so title + body fit the store limit; the
 * footer is never empty, so the body never is.
 */
export function composeBody(
  title: string, main: string, footer: readonly string[],
): { readonly body: string; readonly truncated: boolean } {
  const tail = sanitize(footer.join("\n"));
  const text = sanitize(main).trim();
  if (text === "") return { body: tail, truncated: false };
  const budget = BRAIN_DOCUMENT_MAX_BYTES - utf8ByteLength(title) - utf8ByteLength(tail) - 2;
  if (utf8ByteLength(text) <= budget) return { body: `${text}\n\n${tail}`, truncated: false };
  const kept = truncateUtf8(text, Math.max(0, budget - utf8ByteLength(CONNECTOR_TRUNCATION_MARKER))).value;
  return { body: `${kept}${CONNECTOR_TRUNCATION_MARKER}\n\n${tail}`, truncated: true };
}

/** The canonical https form without credentials, or "" (the store refuses anything else). */
export function canonicalPermalink(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > BRAIN_PERMALINK_MAX_CHARS || !URL.canParse(raw)) return "";
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return "";
  return url.href.length <= BRAIN_PERMALINK_MAX_CHARS ? url.href : "";
}

/** "<prefix>:<identity>" when it satisfies BRAIN_PERSON_KEY_PATTERN, else null. */
export function personKey(prefix: "email" | "linear", identity: string | null | undefined): string | null {
  const value = (identity ?? "").trim();
  if (value === "") return null;
  const key = `${prefix}:${prefix === "email" ? value.toLowerCase() : value}`;
  return key.length <= 256 && BRAIN_PERSON_KEY_PATTERN.test(key) ? key : null;
}

/** ISO-8601 instant in UTC, or null. */
export function isoInstant(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

type CappedRefKind = keyof typeof BRAIN_REFS_PER_KIND_MAX;

/** A document's complete ref set: unique, per-kind caps, the store's total cap and value byte limit. */
export class RefSet {
  private readonly refs: BrainDocumentRef[] = [];
  private readonly seen = new Set<string>();
  private readonly perKind = new Map<string, number>();

  add(kind: BrainRefKind & CappedRefKind, raw: string | null | undefined): this {
    const value = raw === null || raw === undefined ? "" : sanitize(raw).trim();
    if (value === "" || utf8ByteLength(value) > BRAIN_REF_VALUE_MAX_BYTES) return this;
    const key = JSON.stringify([kind, value]);
    const count = this.perKind.get(kind) ?? 0;
    if (this.seen.has(key) || count >= BRAIN_REFS_PER_KIND_MAX[kind] || this.refs.length >= BRAIN_DOCUMENT_REFS_MAX) {
      return this;
    }
    this.seen.add(key);
    this.perKind.set(kind, count + 1);
    this.refs.push({ kind, value });
    return this;
  }

  list(): readonly BrainDocumentRef[] {
    return [...this.refs];
  }
}

/** "<prefix>:" + base64url(JSON); throws when it would not fit a stored cursor (a bug, logged as internal_error). */
export function encodeCursor(prefix: string, value: unknown): string {
  const text = `${prefix}:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
  if (text.length > BRAIN_CURSOR_MAX_CHARS) throw new RangeError("connector cursor too long");
  return text;
}

/** Null for a missing cursor, another prefix or a shape the schema refuses: the adapter starts over. */
export function decodeCursor<T>(prefix: string, text: string | null, schema: z.ZodType<T>): T | null {
  if (text === null || !text.startsWith(`${prefix}:`)) return null;
  const raw = Buffer.from(text.slice(prefix.length + 1), "base64url").toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
