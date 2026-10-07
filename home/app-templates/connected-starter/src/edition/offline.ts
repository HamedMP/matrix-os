import { utf8Size } from "./utf8-size";
import type { EditionMessage, EditionSource, ReadingPatch } from "./types";
import { parseMessage, parseSources } from "./transport";
interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const MAX_BYTES = 5 * 1024 * 1024,
  MAX_ARTICLES = 50,
  MAX_EDITS = 100;
interface Cache {
  messages: EditionMessage[];
  pending: ReadingPatch[];
  sources: EditionSource[];
}
function validPatch(p: ReadingPatch) {
  return (
    !!p &&
    typeof p.id === "string" &&
    p.id.length <= 512 &&
    Number.isSafeInteger(p.baseRevision) &&
    p.baseRevision >= 0 &&
    Object.keys(p).every((k) =>
      ["id", "baseRevision", "saved", "read", "progress"].includes(k),
    ) &&
    (p.saved === undefined || typeof p.saved === "boolean") &&
    (p.read === undefined || typeof p.read === "boolean") &&
    (p.progress === undefined ||
      (Number.isFinite(p.progress) && p.progress >= 0 && p.progress <= 1))
  );
}
/** Explicit device downloads only; scoped by the authenticated runtime, never guessed from storage. */
export class EditionDownloads {
  private readonly key: string;
  constructor(
    private storage: StorageAdapter,
    readonly scope: string,
  ) {
    if (!scope || scope.length > 512)
      throw new Error("Download scope unavailable");
    this.key = "matrix-edition-v1:" + encodeURIComponent(scope);
  }
  private load(): Cache {
    const empty = { messages: [], pending: [], sources: [] };
    const raw = this.storage.getItem(this.key);
    if (!raw) return empty;
    if (raw.length > MAX_BYTES * 2) {
      this.clear();
      return empty;
    }
    try {
      const parsed = JSON.parse(raw);
      if (
        !Array.isArray(parsed.messages) ||
        parsed.messages.length > MAX_ARTICLES ||
        !Array.isArray(parsed.pending) ||
        parsed.pending.length > MAX_EDITS ||
        !parsed.pending.every(validPatch)
      )
        throw new Error("Invalid downloads");
      return {
        messages: parsed.messages.map(parseMessage),
        pending: parsed.pending,
        sources: parseSources({ sources: parsed.sources ?? [] }).sources,
      };
    } catch (error) {
      console.warn("Edition download metadata unavailable", error);
      this.clear();
      return empty;
    }
  }
  private write(cache: Cache) {
    const raw = JSON.stringify(cache);
    if (utf8Size(raw) > MAX_BYTES)
      throw new Error("Download storage is full. Remove an edition first.");
    this.storage.setItem(this.key, raw);
  }
  download(message: EditionMessage) {
    if (
      message.partial ||
      !message.text ||
      message.text.length > 2 * 1024 * 1024
    )
      throw new Error("Complete article content is needed.");
    const cache = this.load();
    const existing = cache.messages.some((m) => m.id === message.id);
    if (!existing && cache.messages.length >= MAX_ARTICLES)
      throw new Error("Download storage is full. Remove an edition first.");
    cache.messages = [
      parseMessage(message),
      ...cache.messages.filter((m) => m.id !== message.id),
    ];
    this.write(cache);
  }
  read(id: string) {
    return this.load().messages.find((m) => m.id === id) ?? null;
  }
  list() {
    return this.load().messages;
  }
  setSources(sources: EditionSource[]) {
    const cache = this.load();
    const allowed = parseSources({ sources }).sources;
    cache.messages = cache.messages.filter((m) =>
      allowed.some(
        (source) =>
          source.id === m.sourceId &&
          (!cache.sources.length ||
            cache.sources.some(
              (previous) =>
                previous.id === source.id &&
                previous.connectionId === source.connectionId,
            )),
      ),
    );
    const ids = new Set(cache.messages.map((m) => m.id));
    cache.pending = cache.pending.filter((p) => ids.has(p.id));
    cache.sources = allowed;
    this.write(cache);
  }
  sources() {
    return this.load().sources;
  }
  remove(id: string) {
    const cache = this.load();
    cache.messages = cache.messages.filter((m) => m.id !== id);
    cache.pending = cache.pending.filter((p) => p.id !== id);
    this.write(cache);
  }
  queue(patch: ReadingPatch) {
    if (!validPatch(patch))
      throw new Error("Only reading updates can wait offline.");
    const cache = this.load(),
      existing = cache.pending.find((p) => p.id === patch.id);
    if (existing) {
      const baseRevision = existing.baseRevision;
      Object.assign(existing, patch, { baseRevision });
    } else {
      if (cache.pending.length >= MAX_EDITS)
        throw new Error("Reconnect to save pending reading updates.");
      cache.pending.push(patch);
    }
    this.write(cache);
  }
  pending() {
    return this.load().pending;
  }
  acknowledge(patch: ReadingPatch, message: EditionMessage) {
    if (message.id !== patch.id)
      throw new Error("Reading confirmation changed");
    const cache = this.load();
    const pending = cache.pending.find((p) => p.id === patch.id);
    if (!pending) return;
    const changed = JSON.stringify(pending) !== JSON.stringify(patch);
    if (changed) pending.baseRevision = message.readingRevision;
    else cache.pending = cache.pending.filter((p) => p.id !== patch.id);
    const { id, baseRevision, ...values } = pending;
    cache.messages = cache.messages.map((m) =>
      m.id === message.id
        ? { ...parseMessage(message), ...(changed ? values : {}) }
        : m,
    );
    this.write(cache);
  }
  clear() {
    this.storage.removeItem(this.key);
  }
}
