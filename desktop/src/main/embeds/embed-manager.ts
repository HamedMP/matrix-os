// Embedded surface lifecycle (FR-064, lesson L14: suspend — don't overlay).
// At most `maxLive` embeds keep a live WebContentsView; the rest are detached
// but restorable. Total records are capped so a runaway open loop can't grow
// unbounded.
import { randomUUID } from "node:crypto";
import { isNavigationAllowed } from "./origin-policy";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EmbedViewLike {
  setBounds(bounds: Bounds): void;
  loadUrl(url: string): Promise<void>;
  attach(): void;
  detach(): void;
  destroy(): void;
}

export type EmbedKind = "hosted-shell" | "app";

export interface EmbedManagerOptions {
  createView: (opts: { partition: string; onState: (state: "loading" | "ready" | "failed") => void }) => EmbedViewLike;
  allowedOrigins: string[];
  maxLive?: number;
}

export const MAX_TOTAL_EMBEDS = 12;
const DEFAULT_MAX_LIVE = 3;
const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ERR_ABORTED = -3;

interface EmbedRecord {
  id: string;
  url: string;
  view: EmbedViewLike;
  live: boolean;
  loadFailed: boolean;
  loadGeneration: number;
  lastUsed: number;
  onState: (state: "loading" | "ready" | "failed") => void;
}

function isAbortedLoadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { code?: unknown; errno?: unknown; message?: unknown };
  return (
    maybe.errno === ERR_ABORTED ||
    maybe.code === "ERR_ABORTED" ||
    (typeof maybe.message === "string" && maybe.message.includes("ERR_ABORTED"))
  );
}

export class EmbedManager {
  private readonly records = new Map<string, EmbedRecord>();
  private readonly createView: EmbedManagerOptions["createView"];
  private readonly allowedOrigins: string[];
  private readonly maxLive: number;
  private tick = 0;

  constructor(options: EmbedManagerOptions) {
    this.createView = options.createView;
    this.allowedOrigins = options.allowedOrigins;
    this.maxLive = options.maxLive ?? DEFAULT_MAX_LIVE;
    if (this.maxLive > MAX_TOTAL_EMBEDS) {
      throw new Error(
        `maxLive (${this.maxLive}) must not exceed MAX_TOTAL_EMBEDS (${MAX_TOTAL_EMBEDS})`,
      );
    }
  }

  open(
    kind: EmbedKind,
    slug: string | null,
    bounds: Bounds,
    url: string,
    options?: { id?: string; onState?: (state: "loading" | "ready" | "failed") => void },
  ): string {
    if (!isNavigationAllowed(url, this.allowedOrigins)) {
      throw new Error("embed URL is not allowed");
    }

    const partition =
      kind === "hosted-shell"
        ? "persist:hosted-shell"
        : this.appPartition(slug);

    const id = options?.id ?? randomUUID();
    if (this.records.has(id)) throw new Error("embed id already exists");
    const onState = options?.onState ?? (() => undefined);
    let record: EmbedRecord | null = null;
    const emitState = (state: "loading" | "ready" | "failed") => {
      if (state === "loading" && record) record.loadFailed = false;
      if (state === "failed" && record) {
        if (record.loadFailed) return;
        record.loadFailed = true;
      }
      onState(state);
    };
    const view = this.createView({ partition, onState: emitState });
    record = {
      id,
      url,
      view,
      live: true,
      loadFailed: false,
      loadGeneration: 0,
      lastUsed: ++this.tick,
      onState: emitState,
    };
    view.attach();
    view.setBounds(bounds);
    this.records.set(id, record);
    this.loadInto(record);

    this.enforceMaxLive();
    this.enforceTotalCap();
    return id;
  }

  setBounds(embedId: string, bounds: Bounds): boolean {
    const record = this.records.get(embedId);
    if (!record) return false;
    record.view.setBounds(bounds);
    return true;
  }

  focus(embedId: string): boolean {
    const record = this.records.get(embedId);
    if (!record) return false;
    record.lastUsed = ++this.tick;
    if (!record.live) {
      record.view.attach();
      record.live = true;
    }
    if (record.loadFailed) {
      record.loadFailed = false;
      this.loadInto(record);
    }
    this.enforceMaxLive();
    return true;
  }

  reload(embedId: string): boolean {
    const record = this.records.get(embedId);
    if (!record) return false;
    record.lastUsed = ++this.tick;
    if (!record.live) {
      record.view.attach();
      record.live = true;
    }
    record.loadFailed = false;
    record.onState("loading");
    this.loadInto(record);
    this.enforceMaxLive();
    return true;
  }

  close(embedId: string): boolean {
    const record = this.records.get(embedId);
    if (!record) return false;
    this.destroyRecord(record);
    this.records.delete(embedId);
    return true;
  }

  closeAll(): void {
    for (const record of this.records.values()) this.destroyRecord(record);
    this.records.clear();
  }

  has(embedId: string): boolean {
    return this.records.has(embedId);
  }

  get liveCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.live) count += 1;
    return count;
  }

  private appPartition(slug: string | null): string {
    if (!slug || !SAFE_SLUG.test(slug)) {
      throw new Error("invalid app slug for embed partition");
    }
    return `persist:app-${slug}`;
  }

  private loadInto(record: EmbedRecord): void {
    const generation = ++record.loadGeneration;
    void record.view.loadUrl(record.url).catch((err: unknown) => {
      if (this.records.get(record.id) !== record || record.loadGeneration !== generation) return;
      if (isAbortedLoadError(err)) return;
      console.warn(
        "[embed-manager] embed load failed:",
        err instanceof Error ? err.message : String(err),
      );
      record.onState("failed");
    });
  }

  private enforceMaxLive(): void {
    while (this.liveCount > this.maxLive) {
      const victim = this.leastRecentlyUsed((r) => r.live);
      if (!victim) break;
      victim.view.detach();
      victim.live = false;
    }
  }

  private enforceTotalCap(): void {
    while (this.records.size > MAX_TOTAL_EMBEDS) {
      const victim =
        this.leastRecentlyUsed((r) => !r.live) ?? this.leastRecentlyUsed(() => true);
      if (!victim) break;
      this.destroyRecord(victim);
      this.records.delete(victim.id);
    }
  }

  private destroyRecord(record: EmbedRecord): void {
    if (record.live) {
      record.view.detach();
      record.live = false;
    }
    record.view.destroy();
  }

  private leastRecentlyUsed(predicate: (record: EmbedRecord) => boolean): EmbedRecord | null {
    let chosen: EmbedRecord | null = null;
    for (const record of this.records.values()) {
      if (!predicate(record)) continue;
      if (!chosen || record.lastUsed < chosen.lastUsed) chosen = record;
    }
    return chosen;
  }
}
