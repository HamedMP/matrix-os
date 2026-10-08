/**
 * Graph identifiers and text rules: entity and link ids, entity refs, person keys, opaque cursors and query dates.
 * Pure functions.
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { BrainApiError } from "../api/types.js";
import {
  BRAIN_DATE_PATTERN, BRAIN_ENTITY_DISPLAY_NAME_MAX_CHARS, BRAIN_ENTITY_ID_PATTERN, BRAIN_ENTITY_ID_VERSION,
  BRAIN_ENTITY_KEY_MAX_BYTES, BRAIN_ENTITY_KINDS, BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_ISSUE_KEY_PATTERN,
  BRAIN_PERSON_KEY_PATTERN, BRAIN_PR_NUMBER_PATTERN, type BrainEntityKind,
} from "../contracts.js";
import { isIndexablePath } from "../git/index.js";
import type { BrainEntityDraft } from "./types.js";

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function brainEntityId(kind: BrainEntityKind, key: string): string {
  return `ent_${sha256([BRAIN_ENTITY_ID_VERSION, kind, key]).slice(0, 32)}`;
}

export function brainLinkId(documentId: string, type: string, fromId: string, toId: string): string {
  return `lnk_${sha256(["brain_link_v1", documentId, type, fromId, toId]).slice(0, 32)}`;
}

/** Cut to maxChars UTF-16 units without splitting a surrogate pair; whitespace runs collapsed. */
export function cutText(text: string, maxChars: number): string {
  let out = text.replace(/\s+/gu, " ").trim();
  if (out.length <= maxChars) return out;
  out = out.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

export function entityDraft(kind: BrainEntityKind, key: string, displayName: string): BrainEntityDraft {
  const name = cutText(displayName, BRAIN_ENTITY_DISPLAY_NAME_MAX_CHARS);
  return { kind, key, displayName: name === "" ? cutText(key, BRAIN_ENTITY_DISPLAY_NAME_MAX_CHARS) : name };
}

/** Whether `key` is a valid key for `kind` (contracts/graph.ts entity keys). */
export function isEntityKey(kind: BrainEntityKind, key: string): boolean {
  const bytes = Buffer.byteLength(key, "utf8");
  if (key.length === 0 || bytes > BRAIN_ENTITY_KEY_MAX_BYTES || !key.isWellFormed()) return false;
  switch (kind) {
    case "person": return BRAIN_PERSON_KEY_PATTERN.test(key);
    case "file": case "folder": case "spec": return isIndexablePath(key);
    case "pull_request": return BRAIN_PR_NUMBER_PATTERN.test(key);
    case "issue": return BRAIN_ISSUE_KEY_PATTERN.test(key);
    case "document": return /^[a-f0-9]{64}$/.test(key);
    default: return /^proj_[A-Za-z0-9_-]{1,128}$/.test(key);
  }
}

/** An entity id, or an entity ref `kind:key`; null when neither. */
export function parseEntityInput(
  raw: string,
): { readonly entityId: string; readonly kind: BrainEntityKind | null } | null {
  if (BRAIN_ENTITY_ID_PATTERN.test(raw)) return { entityId: raw, kind: null };
  const colon = raw.indexOf(":");
  const kind = BRAIN_ENTITY_KINDS.find((candidate) => candidate === raw.slice(0, colon));
  // A folder or file ref may end with one "/" (as brain_why accepts); the key never does.
  const key = (kind === "file" || kind === "folder") && raw.endsWith("/") ? raw.slice(colon + 1, -1)
    : raw.slice(colon + 1);
  return kind !== undefined && isEntityKey(kind, key) ? { entityId: brainEntityId(kind, key), kind } : null;
}

/** name: NFC, whitespace runs to one space, trimmed, lowercased; null when not a valid key (pattern and 512 bytes). */
export function personNameKey(name: string): string | null {
  const key = `name:${name.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase()}`;
  return isEntityKey("person", key) ? key : null;
}

export function personEmailKey(email: string): string | null {
  const address = email.trim().toLowerCase();
  const key = `email:${address}`;
  return /^[^\s@<>]+@[^\s@<>]+$/.test(address) && isEntityKey("person", key) ? key : null;
}

/** Display text of a person key: the part after the prefix. */
export function personDisplay(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

// Cursors: base64url JSON {"v":1,"q":<query fingerprint>,"at":...,"id":...}; another query's cursor is invalid_request.

/** Exactly what encodeGraphCursor writes; ids never contain quotes or backslashes. */
const CURSOR_JSON = /^\{"v":1,"q":"([a-f0-9]{16})","at":"([^"\\]{1,40})","id":"([a-z0-9_:]{1,160})"\}$/;
const CursorAtSchema = z.iso.datetime({ precision: 6 }).refine((at) => !at.startsWith("0000-"));

export function queryFingerprint(parts: unknown): string {
  return sha256(["brain_graph_query_v1", parts]).slice(0, 16);
}

export function encodeGraphCursor(fingerprint: string, at: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, q: fingerprint, at, id }), "utf8").toString("base64url");
}

export function decodeGraphCursor(cursor: string, fingerprint: string): { readonly at: string; readonly id: string } {
  const valid = cursor.length <= BRAIN_FEATURE_CURSOR_MAX_CHARS && /^[A-Za-z0-9_-]+$/.test(cursor);
  const parts = valid ? CURSOR_JSON.exec(Buffer.from(cursor, "base64url").toString("utf8")) : null;
  if (parts === null || parts[1] !== fingerprint || !CursorAtSchema.safeParse(parts[2]).success) {
    throw new BrainApiError("invalid_request");
  }
  return { at: parts[2]!, id: parts[3]! };
}

/** "YYYY-MM-DD" (UTC midnight) or an ISO-8601 instant with an offset, as an ISO string; else invalid_request. */
export function parseQueryDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const valid = BRAIN_DATE_PATTERN.test(value) ? z.iso.date().safeParse(value).success
    : z.iso.datetime({ offset: true }).safeParse(value).success;
  const date = new Date(BRAIN_DATE_PATTERN.test(value) ? `${value}T00:00:00.000Z` : value);
  if (!valid || date.getUTCFullYear() < 1) throw new BrainApiError("invalid_request");
  return date.toISOString();
}
