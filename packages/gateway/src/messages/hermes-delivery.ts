import { MESSAGING_HERMES_DELIVERY_REGISTRY_CAP, MESSAGING_REVOCATION_ABORT_DEADLINE_MS } from "./constants.js";

export interface HermesAbortEntry {
  abortTokenId: string;
  controller: AbortController;
  lastTouched: number;
}

export class HermesDeliveryRegistry {
  private readonly entries = new Map<string, HermesAbortEntry>();

  constructor(
    private readonly maxEntries = MESSAGING_HERMES_DELIVERY_REGISTRY_CAP,
    private readonly ttlMs = MESSAGING_REVOCATION_ABORT_DEADLINE_MS,
  ) {}

  register(abortTokenId: string, nowMs = Date.now()): AbortSignal {
    this.sweep(nowMs);
    if (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastTouched - b.lastTouched)[0];
      if (oldest) this.entries.delete(oldest.abortTokenId);
    }
    const controller = new AbortController();
    this.entries.set(abortTokenId, { abortTokenId, controller, lastTouched: nowMs });
    return controller.signal;
  }

  abort(abortTokenId: string): boolean {
    const entry = this.entries.get(abortTokenId);
    if (!entry) return false;
    entry.controller.abort();
    this.entries.delete(abortTokenId);
    return true;
  }

  sweep(nowMs = Date.now()): void {
    for (const [id, entry] of this.entries) {
      if (nowMs - entry.lastTouched > this.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }
}
