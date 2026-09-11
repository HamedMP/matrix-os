import type { AgentThreadEvent } from "@matrix-os/contracts";
import type { AiTokenUsage } from "../ai-analytics.js";
import { boundedOperation } from "../bounded-operation.js";

export const MAX_BUFFERED_EVENTS = 10_000;
export const MAX_BUFFERED_EVENT_BYTES = 2 * 1024 * 1024;
const RECONCILE_MS = 30_000;

/** Server-side delivery repair, never a tool retry or a client polling loop. */
export class ThreadEventInbox {
  private readonly queued: AgentThreadEvent[] = [];
  private queuedBytes = 0;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private tokenUsage: AiTokenUsage | undefined;
  private recover: ((signal: AbortSignal) => Promise<AgentThreadEvent[]>) | undefined;
  lastEventId: string | undefined;
  private nextRecoveryAt = Date.now() + RECONCILE_MS;
  private recoveryFailures = 0;

  constructor(private readonly signal: AbortSignal) {}

  reconcileWith(recover: (signal: AbortSignal) => Promise<AgentThreadEvent[]>): void {
    this.recover = recover;
  }

  push(events: AgentThreadEvent[], tokenUsage?: AiTokenUsage): void {
    if (this.signal.aborted || this.failure) return;
    const bytes = Buffer.byteLength(JSON.stringify(events), "utf8");
    if (this.queued.length + events.length > MAX_BUFFERED_EVENTS
      || this.queuedBytes + bytes > MAX_BUFFERED_EVENT_BYTES) {
      this.fail(new Error("Canonical coding Provider event buffer exceeded"));
      return;
    }
    this.queued.push(...events);
    this.queuedBytes += bytes;
    if (tokenUsage) this.tokenUsage = tokenUsage;
    this.wake?.();
  }

  takeTokenUsage(): AiTokenUsage | undefined {
    const usage = this.tokenUsage;
    this.tokenUsage = undefined;
    return usage;
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.wake?.();
  }

  private async repair(): Promise<void> {
    try {
      const events = await boundedOperation(this.recover!, 10_000, this.signal);
      this.push(events);
      this.recoveryFailures = 0;
    } catch (error: unknown) {
      if (this.signal.aborted) return;
      this.recoveryFailures += 1;
      console.warn("[chat/event-recovery] Snapshot unavailable", {
        attempt: this.recoveryFailures,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      if (this.recoveryFailures >= 5) this.fail(new Error("Chat event recovery unavailable"));
    } finally {
      this.nextRecoveryAt = Date.now() + Math.min(RECONCILE_MS * 2 ** this.recoveryFailures, 120_000);
    }
  }

  async next(): Promise<AgentThreadEvent[] | null> {
    while (!this.signal.aborted) {
      if (this.failure) throw this.failure;
      // A stream of heartbeats must not postpone durable reconciliation.
      if (this.recover && Date.now() >= this.nextRecoveryAt) await this.repair();
      if (this.failure) throw this.failure;
      if (this.queued.length > 0) {
        const events = this.queued.splice(0);
        this.queuedBytes = 0;
        return events;
      }
      if (this.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.signal.removeEventListener("abort", finish);
          this.wake = undefined;
          resolve();
        };
        const timer = setTimeout(finish, this.recover ? Math.max(1, this.nextRecoveryAt - Date.now()) : RECONCILE_MS);
        timer.unref?.();
        this.signal.addEventListener("abort", finish, { once: true });
        this.wake = finish;
      });
    }
    return null;
  }
}
