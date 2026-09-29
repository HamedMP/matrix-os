import type { ChatOutboxEvent, ChatOwner } from "./records.js";

const MAX_PENDING_EVENTS_PER_TRANSACTION = 100;
const MAX_SINKS = 8;

export type ChatOutboxSink = (input: { owner: ChatOwner; event: ChatOutboxEvent }) => void;
export type PendingChatOutboxEvent = { owner: ChatOwner; event: ChatOutboxEvent };

export class ChatOutboxDelivery {
  private readonly sinks = new Set<ChatOutboxSink>();
  private released = false;
  private readonly pendingByExecutor = new WeakMap<object, PendingChatOutboxEvent[]>();

  /**
   * Bounded multi-sink registration: the canonical event stream and auxiliary
   * projections (voice delivery, telemetry) each subscribe independently.
   * Per-sink failures are isolated at flush so one consumer cannot starve the
   * others; `release()` still detaches every subscriber at shutdown.
   */
  registerSink(sink: ChatOutboxSink): { dispose(): void } {
    if (this.released) throw new Error("Chat outbox sink is unavailable");
    if (this.sinks.size >= MAX_SINKS) throw new Error("Chat outbox sink limit exceeded");
    this.sinks.add(sink);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.sinks.delete(sink);
      },
    };
  }

  begin(executor: object): PendingChatOutboxEvent[] {
    const pending: PendingChatOutboxEvent[] = [];
    this.pendingByExecutor.set(executor, pending);
    return pending;
  }

  end(executor: object): void {
    this.pendingByExecutor.delete(executor);
  }

  capture(executor: object, event: PendingChatOutboxEvent): void {
    const pending = this.pendingByExecutor.get(executor);
    if (!pending) return;
    if (pending.length >= MAX_PENDING_EVENTS_PER_TRANSACTION) {
      throw new Error("Chat transaction outbox limit exceeded");
    }
    pending.push(event);
  }

  flush(pending: PendingChatOutboxEvent[]): void {
    if (this.released || this.sinks.size === 0) return;
    for (const event of pending) {
      for (const sink of this.sinks) {
        try {
          sink(event);
        } catch (error: unknown) {
          console.warn(
            "[chat/outbox-delivery] Sink delivery failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      }
    }
  }

  release(): void {
    this.released = true;
    this.sinks.clear();
  }
}
