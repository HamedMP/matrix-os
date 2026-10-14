import { setTimeout as delay } from "node:timers/promises";

/** One bounded, coalescing activity worker per existing input queue; delivery never waits on it. */
export class InputActivityRecorder {
  private latest: string | undefined;
  private worker: Promise<void> | undefined;
  private lastWrite = 0;

  constructor(private readonly timestamp: () => string, private readonly persist: (at: string) => Promise<void>) {}

  get pending(): boolean { return this.worker !== undefined; }

  mark(): void {
    try { this.latest = this.timestamp(); }
    catch (error: unknown) {
      console.error("[terminal-runtime] failed to capture input activity", error instanceof Error ? error.name : "unknown_error");
      return;
    }
    this.start();
  }

  async flush(): Promise<void> {
    while (this.worker) await this.worker;
  }

  private start(): void {
    if (this.worker) return;
    this.worker = this.drain().finally(() => {
      this.worker = undefined;
      if (this.latest) this.start();
    });
  }

  private async drain(): Promise<void> {
    while (this.latest) {
      const wait = Math.max(0, this.lastWrite + 250 - Date.now());
      if (wait > 0) await delay(wait, undefined, { ref: false });
      const at = this.latest;
      this.latest = undefined;
      try { await this.persist(at); }
      catch (error: unknown) {
        console.error("[terminal-runtime] failed to record input activity", error instanceof Error ? error.name : "unknown_error");
      }
      this.lastWrite = Date.now();
    }
  }
}
