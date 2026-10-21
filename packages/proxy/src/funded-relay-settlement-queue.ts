import type { FundedAiFinalizationRequest, FundedAiTerminalOutcomeRequest } from "@matrix-os/contracts";

interface PendingSettlement {
  task: FundedAiFinalizationRequest | FundedAiTerminalOutcomeRequest;
  kind: "finalize" | "terminal";
  expiresAt: number;
}

export class SettlementRetryQueue {
  private readonly pending = new Map<string, PendingSettlement>();
  private readonly timer: ReturnType<typeof setInterval>;
  private flushing: Promise<void> | null = null;
  private closing = false;

  constructor(private readonly options: {
    capacity: number;
    ttlMs: number;
    retryIntervalMs: number;
    batchSize?: number;
    now: () => number;
    finalize: (task: FundedAiFinalizationRequest) => Promise<unknown>;
    terminal?: (task: FundedAiTerminalOutcomeRequest) => Promise<unknown>;
  }) {
    this.timer = setInterval(() => {
      this.sweepExpired();
      void this.flush();
    }, options.retryIntervalMs);
    this.timer.unref?.();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  enqueue(task: FundedAiFinalizationRequest): void { this.add(task, "finalize"); }

  enqueueTerminal(task: FundedAiTerminalOutcomeRequest): void { this.add(task, "terminal"); }

  private add(task: PendingSettlement["task"], kind: PendingSettlement["kind"]): void {
    if (this.closing) return;
    this.sweepExpired();
    const existing = this.pending.get(task.reservationId);
    if (existing && !(existing.kind === "terminal" && kind === "finalize" && "mode" in task && task.mode === "exact")) {
      if (existing.kind === "finalize" && kind === "terminal") return;
      if (JSON.stringify(existing.task) !== JSON.stringify(task)) {
        console.warn("[proxy] Conflicting funded AI finalization was ignored");
      }
      return;
    }
    if (!existing && this.pending.size >= this.options.capacity) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest !== undefined) this.pending.delete(oldest);
      console.warn("[proxy] Funded AI finalization queue evicted its oldest work");
    }
    this.pending.set(task.reservationId, {
      task, kind,
      expiresAt: this.options.now() + this.options.ttlMs,
    });
    void this.flush();
  }

  sweepExpired(): void {
    const now = this.options.now();
    for (const [reservationId, item] of this.pending) {
      if (item.expiresAt <= now) this.pending.delete(reservationId);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const running = this.flushOnce();
    this.flushing = running;
    try {
      await running;
    } finally {
      if (this.flushing === running) this.flushing = null;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    await this.flush();
    if (this.pending.size > 0) await this.flush();
    this.pending.clear();
  }

  private async flushOnce(): Promise<void> {
    this.sweepExpired();
    const batchSize = this.options.batchSize ?? 16;
    const batch = [...this.pending].slice(0, batchSize);
    await Promise.all(batch.map(async ([reservationId, item]) => {
      try {
        if (item.kind === "terminal") {
          if (!this.options.terminal) throw new Error("Terminal outcome transport is missing");
          await this.options.terminal(item.task as FundedAiTerminalOutcomeRequest);
        } else await this.options.finalize(item.task as FundedAiFinalizationRequest);
        if (this.pending.get(reservationId) === item) this.pending.delete(reservationId);
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status) : null;
        if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          if (this.pending.get(reservationId) === item) this.pending.delete(reservationId);
        }
        const errorName = error instanceof Error ? error.name : "UnknownError";
        console.warn("[proxy] Funded AI finalization retry failed", { errorName, status });
      }
    }));
  }
}
