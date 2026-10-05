import { MEMORY_ENGINES } from "@matrix-os/contracts";
import type { MemoryWorkspaceRepository } from "./repository.js";
import type { MemoryEngines } from "./engines/index.js";
/** Two engine lanes, one job at a time per lane; database leases survive gateway restarts. */
export class MemoryIngestionWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private lastPruned = 0;
  private controller = new AbortController();
  constructor(
    private repository: MemoryWorkspaceRepository,
    private engines: MemoryEngines,
  ) {}
  start() {
    if (this.timer || this.running || this.stopping) return;
    this.schedule(0);
  }
  private schedule(ms: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
        if (!this.stopping) this.schedule(1000);
      });
    }, ms);
    this.timer.unref();
  }
  async tick() {
    if (Date.now() - this.lastPruned > 3600000) {
      try {
        await this.repository.prune();
        this.lastPruned = Date.now();
      } catch (error) {
        console.warn(
          "[memory-workspace] Retention cleanup failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    const lanes = await Promise.allSettled(
      MEMORY_ENGINES.map(async (engine) => {
        const adapter = this.engines[engine];
        if (!adapter || this.stopping) return;
        const job = await this.repository.claimJob(engine, 240000);
        if (!job) return;
        let success = false;
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(220000),
        ]);
        try {
          const source = await this.repository.getSource(
            job.ownerId,
            job.sourceId,
          );
          if (source && source.revision !== job.revision) {
            success = true;
          } else if (job.operation === "delete" || !source) {
            await adapter.delete(job.ownerId, job.sourceId, signal);
            success = true;
          } else {
            await adapter.upsert(job.ownerId, source, signal);
            success = true;
          }
        } catch (error) {
          console.warn(
            "[memory-workspace] Ingestion attempt failed",
            engine,
            error instanceof Error ? error.name : "UnknownError",
          );
        }
        await this.repository.finishJob(job.id, job.leaseToken, success);
      }),
    );
    for (const lane of lanes)
      if (lane.status === "rejected")
        console.error(
          "[memory-workspace] Worker cycle failed",
          lane.reason instanceof Error ? lane.reason.name : "UnknownError",
        );
  }
  async close() {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.controller.abort();
    await this.running;
  }
}
