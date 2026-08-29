import type { ChatOutboxEvent, ChatOwner } from "./records.js";

const MAX_PENDING_EVENTS_PER_TRANSACTION = 100;

export type ChatOutboxSink = (input: { owner: ChatOwner; event: ChatOutboxEvent }) => void;
export type PendingChatOutboxEvent = { owner: ChatOwner; event: ChatOutboxEvent };

export class ChatOutboxDelivery {
  private sink: ChatOutboxSink | null = null;
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
    const sink = this.released ? null : this.sink;
    if (!sink) return;
    for (const event of pending) {
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

  release(): void {
    this.released = true;
    this.sink = null;
  }
}
