import { createHash } from "node:crypto";
import { AgentThreadEventSchema, type AgentThreadEvent } from "@matrix-os/contracts";
import type { CodingAgentProviderEventBatch, CodingAgentProviderEventPublisher } from "./provider-adapter.js";

// Tool starts seed completion identity, so both lifecycle events remain controls.
function isDisplay(event: AgentThreadEvent): boolean {
  return ["assistant.text.delta", "assistant.text.completed", "tool.output"].includes(event.type);
}

export function codingPreviewOmissionNotice(options: { threadId: string; scope: string; now: () => Date; nextEventId: () => string }): AgentThreadEvent[] {
  const messageId = `msg_omitted_${createHash("sha256").update(options.scope).digest("hex").slice(0, 24)}`;
  const base = () => ({ threadId: options.threadId, eventId: options.nextEventId(), occurredAt: options.now().toISOString(), messageId });
  return [
    AgentThreadEventSchema.parse({ ...base(), type: "assistant.text.delta", delta: "Some output was omitted from this preview." }),
    AgentThreadEventSchema.parse({ ...base(), type: "assistant.text.completed" }),
  ];
}

/** Controls cannot silently disappear when ordinary presentation fills a buffer. */
export function fitCodingPreviewEvents(events: readonly AgentThreadEvent[], capacity: number): AgentThreadEvent[] {
  const controls = events.filter(event => !isDisplay(event)).length;
  if (controls > capacity) throw new RangeError("Coding control queue full");
  let displaySlots = capacity - controls;
  return events.filter(event => !isDisplay(event) || displaySlots-- > 0);
}

/** At most 480 queued events plus one <=100-event in-flight publication. */
export function createCodingPreviewPublisher(
  publish: CodingAgentProviderEventPublisher,
  maxPendingEvents = 480,
  options: { signal?: AbortSignal; onFailure?: (error: unknown) => void } = {},
) {
  const queue: CodingAgentProviderEventBatch[] = [];
  const cancellation = new AbortController();
  let pending = 0;
  let failure: unknown;
  let truncated = false;
  let closed = false;
  let draining = false;
  let tail = Promise.resolve();
  const size = (batch: CodingAgentProviderEventBatch) => batch.events.length + (batch.resumeState ? 1 : 0);

  function close(error: unknown, notify: boolean) {
    if (closed) return;
    closed = true;
    failure = error ?? new Error("Coding publication failed");
    cancellation.abort(failure);
    queue.length = 0;
    pending = 0;
    if (notify) {
      try { options.onFailure?.(failure); }
      catch (callbackError: unknown) { console.warn("[coding-agents] publication cleanup failed", callbackError instanceof Error ? callbackError.name : "UnknownError"); }
    }
  }
  async function exchange(batch: CodingAgentProviderEventBatch) {
    const deadline = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    const timer = setTimeout(() => deadline.abort(new DOMException("Publication timed out", "TimeoutError")), 30_000);
    timer.unref?.();
    let abort: () => void = () => undefined;
    try {
      await Promise.race([
        publish(batch),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  function drain() {
    if (draining) return;
    draining = true;
    tail = (async () => {
      try {
        while (queue.length && !closed) {
          const batch = queue.shift()!;
          pending -= size(batch);
          try { await exchange(batch); }
          catch (error: unknown) { close(error, !options.signal?.aborted && !cancellation.signal.aborted); }
        }
      } finally { draining = false; }
    })();
  }
  return {
    queue(batch: CodingAgentProviderEventBatch): void {
      if (closed) return;
      if (options.signal?.aborted) { close(options.signal.reason, false); return; }
      const stateSize = batch.resumeState ? 1 : 0;
      const required = batch.events.filter(event => !isDisplay(event)).length + stateSize;
      let shortage = required - (maxPendingEvents - pending);
      // Only queued display can be evicted. An in-flight write may already have
      // committed and must never be changed or replayed after unknown delivery.
      for (const waiting of queue) {
        if (shortage <= 0) break;
        waiting.events = waiting.events.filter(event => {
          if (shortage > 0 && isDisplay(event)) { shortage--; pending--; truncated = true; return false; }
          return true;
        });
      }
      for (let index = queue.length - 1; index >= 0; index--) {
        if (!size(queue[index]!)) queue.splice(index, 1);
      }
      let events: AgentThreadEvent[];
      try { events = fitCodingPreviewEvents(batch.events, maxPendingEvents - pending - stateSize); }
      catch (error: unknown) { close(error, true); return; }
      truncated ||= events.length !== batch.events.length;
      if (!events.length && !stateSize) return;
      const accepted = { ...batch, events };
      if (!events.length) queue.push(accepted);
      for (let index = 0; index < events.length; index += 100) {
        const part = events.slice(index, index + 100);
        queue.push(index === 0 ? { ...accepted, events: part } : { events: part });
      }
      pending += size(accepted);
      drain();
    },
    abort() { close(new DOMException("Publication cancelled", "AbortError"), false); },
    finished: () => tail,
    get failure() { return failure; },
    get truncated() { return truncated; },
  };
}
