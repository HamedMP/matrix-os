// Embedded surface lifecycle (FR-064, lesson L14: suspend — don't overlay).
// At most `maxLive` embeds keep a live WebContentsView; the rest are detached
// but restorable. Total records are capped so a runaway open loop can't grow
// unbounded.
import { randomUUID } from "node:crypto";

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
  createView: (opts: { partition: string }) => EmbedViewLike;
  maxLive?: number;
}

export const MAX_TOTAL_EMBEDS = 12;
const DEFAULT_MAX_LIVE = 3;
const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

interface EmbedRecord {
  id: string;
  url: string;
  view: EmbedViewLike;
  live: boolean;
  loadFailed: boolean;
  lastUsed: number;
}

export class EmbedManager {
  private readonly records = new Map<string, EmbedRecord>();
  private readonly createView: EmbedManagerOptions["createView"];
  private readonly maxLive: number;
  private tick = 0;

  constructor(options: EmbedManagerOptions) {
    this.createView = options.createView;
    this.maxLive = options.maxLive ?? DEFAULT_MAX_LIVE;
  }

  open(kind: EmbedKind, slug: string | null, bounds: Bounds, url: string): string {
    const partition =
      kind === "hosted-shell"
        ? "persist:hosted-shell"
        : this.appPartition(slug);

    const id = randomUUID();
    const view = this.createView({ partition });
    const record: EmbedRecord = {
      id,
      url,
      view,
      live: true,
      loadFailed: false,
      lastUsed: ++this.tick,
    };
    view.attach();
    view.setBounds(bounds);
    this.loadInto(record);
    this.records.set(id, record);

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

  // Show or hide an embed by attaching/detaching its native view from the
  // window. Detaching is what actually removes the overlay — a WebContentsView
  // always paints above the renderer, so bounds tricks can't hide it.
  setActive(embedId: string, active: boolean): boolean {
    const record = this.records.get(embedId);
    if (!record) return false;
    if (active) {
      if (!record.live) {
        record.view.attach();
        record.live = true;
      }
      record.lastUsed = ++this.tick;
      if (record.loadFailed) {
        record.loadFailed = false;
        this.loadInto(record);
      }
      this.enforceMaxLive();
    } else if (record.live) {
      record.view.detach();
      record.live = false;
    }
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

  close(embedId: string): boolean {
    const record = this.records.get(embedId);
    if (!record) return false;
    record.view.destroy();
    this.records.delete(embedId);
    return true;
  }

  closeAll(): void {
    for (const record of this.records.values()) record.view.destroy();
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
    void record.view.loadUrl(record.url).catch((err: unknown) => {
      console.warn(
        "[embed-manager] embed load failed:",
        err instanceof Error ? err.message : String(err),
      );
      record.loadFailed = true;
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
      victim.view.destroy();
      this.records.delete(victim.id);
    }
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
