import type { ChatOutboxEvent, ChatOwner } from "./records.js";

const MAX_PENDING_EVENTS_PER_TRANSACTION = 100;
/** Observers are fixed gateway subsystems (the project board), never per-request listeners. */
const MAX_OBSERVERS = 8;

export type ChatOutboxSink = (input: { owner: ChatOwner; event: ChatOutboxEvent }) => void;
export type PendingChatOutboxEvent = { owner: ChatOwner; event: ChatOutboxEvent };

export class ChatOutboxDelivery {
  private sink: ChatOutboxSink | null = null;
  private readonly observers: ChatOutboxSink[] = [];
  private released = false;
  private readonly pendingByExecutor = new WeakMap<object, PendingChatOutboxEvent[]>();

  registerSink(sink: ChatOutboxSink): { dispose(): void } {
    if (this.released) throw new Error("Chat outbox sink is unavailable");
    if (this.sink) throw new Error("Chat outbox sink already registered");
    this.sink = sink;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.sink === sink) this.sink = null;
      },
    };
  }

  /**
   * Add a committed-event observer beside the one event-stream sink. Each
   * observer is called after the sink, and one failing never affects the others.
   */
  addObserver(observer: ChatOutboxSink): { dispose(): void } {
    if (this.released) throw new Error("Chat outbox sink is unavailable");
    if (this.observers.length >= MAX_OBSERVERS) throw new Error("Chat outbox observer limit reached");
    this.observers.push(observer);
    return {
      dispose: () => {
        const index = this.observers.indexOf(observer);
        if (index >= 0) this.observers.splice(index, 1);
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
    if (this.released) return;
    const receivers = [...(this.sink ? [this.sink] : []), ...this.observers];
    if (receivers.length === 0) return;
    for (const event of pending) {
      for (const receiver of receivers) {
        try {
          receiver(event);
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
    this.sink = null;
    this.observers.length = 0;
  }
}
