/**
 * Small building blocks the mail adapters share: a size-capped LRU, a bounded
 * parallel map, opaque cursors and input checks.
 */
import { ProviderError } from "../types/mail.js";

/**
 * Least-recently-used cache capped by entry count and by total weight. An
 * entry heavier than the whole budget is not stored.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight = Number.POSITIVE_INFINITY,
    private readonly weigh: (value: V) => number = () => 1,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
  }

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.totalWeight;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  set(key: K, value: V): void {
    this.delete(key);
    const weight = Math.max(0, this.weigh(value));
    if (weight > this.maxWeight) return;
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }
}

/**
 * Maps `items` through `fn` with at most `limit` calls running, keeping order.
 * The first rejection rejects the whole map and no further items start.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error: unknown) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

const MAX_CURSOR_CHARS = 4096;

/** An opaque cursor: a kind tag and a provider value without whitespace. */
export function encodeCursor(kind: string, value: string | number): string {
  return `${kind}.${value}`;
}

/** The value of a cursor of the given kind. A foreign or malformed cursor is `not_supported`. */
export function decodeCursor(cursor: string | undefined, kinds: readonly string[]): { kind: string; value: string } | null {
  if (cursor === undefined || cursor === "") return null;
  const dot = cursor.indexOf(".");
  const kind = dot === -1 ? "" : cursor.slice(0, dot);
  const value = dot === -1 ? "" : cursor.slice(dot + 1);
  if (cursor.length > MAX_CURSOR_CHARS || !kinds.includes(kind) || !value || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new ProviderError("not_supported", "This page is no longer available. Reload the list.");
  }
  return { kind, value };
}

/** Rejects with `not_supported` when `value` is not an id of the expected form. */
export function requireId(value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    throw new ProviderError("not_supported", "That item could not be found.");
  }
  return value;
}

export const GMAIL_ID = /^[A-Za-z0-9_-]+$/;
export const GMAIL_ID_MAX = 128;
export const GMAIL_ATTACHMENT_ID_MAX = 2048;
export const GRAPH_ID = /^[A-Za-z0-9_+=-]+$/;
export const GRAPH_ID_MAX = 512;
