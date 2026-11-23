/**
 * Live composer bodies by draft, so docking, popping out and reopening a
 * draft keep the exact redline (change ids, authors, dates) instead of
 * re-reading it from the stored HTML. An entry is reused only while the
 * draft still holds the body it last wrote; anything else is re-read.
 */
import { ComposeBody } from "./compose-body";

/** Bodies kept; the least recently used is dropped first. */
export const MAX_LIVE_BODIES = 10;

interface Entry {
  body: ComposeBody;
  /** The `bodyHtml` this body last wrote into the draft. */
  written: string;
}

const live = new Map<string, Entry>();

/** The live body of a draft whose stored HTML is `bodyHtml`; `reused` is false when it was read from the HTML. */
export function bodyFor(localId: string, bodyHtml: string, now: string): { body: ComposeBody; reused: boolean } {
  const entry = live.get(localId);
  const reused = entry !== undefined && entry.written === bodyHtml;
  const body = reused ? entry.body : ComposeBody.fromDraftHtml(bodyHtml, now);
  remember(localId, body, bodyHtml);
  return { body, reused };
}

/** Records what `body` wrote into the draft. */
export function remember(localId: string, body: ComposeBody, written: string): void {
  live.delete(localId);
  live.set(localId, { body, written });
  while (live.size > MAX_LIVE_BODIES) {
    const oldest = live.keys().next().value;
    if (oldest === undefined) break;
    live.delete(oldest);
  }
}

export function forget(localId: string): void {
  live.delete(localId);
}

export function liveBodyCount(): number {
  return live.size;
}
