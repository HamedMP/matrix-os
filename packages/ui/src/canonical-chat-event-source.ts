import {
  CanonicalChatStreamServerFrameSchema,
  type CanonicalChatStreamEvent,
} from "@matrix-os/contracts";

const DEFAULT_MAX_CONSUMERS = 16;
const DEFAULT_MAX_SEEN_CURSORS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 45_000;
const DEFAULT_CONNECTION_LIFETIME_MS = 5 * 60 * 1000;
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024;

export class ChatEventFrameTooLarge extends Error {
  constructor() {
    super("Chat event frame exceeded limit");
    this.name = "ChatEventFrameTooLarge";
  }
}

export type CanonicalChatInvalidation =
  | {
      type: "chat.changed";
      chatId: string;
      cursor: number;
      revision: number;
      eventType: CanonicalChatStreamEvent["eventType"];
    }
  | { type: "chat.full_refresh"; cursor?: number };

export type CanonicalChatEventConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "disposed";

export interface CanonicalChatEventSource {
  subscribe(listener: (event: CanonicalChatInvalidation) => void): { dispose(): void };
  subscribeConnectionState(listener: () => void): { dispose(): void };
  connectionState(): CanonicalChatEventConnectionState;
  start(): Promise<void>;
  dispose(): void;
  activeInvalidationConsumerCount(): number;
}

export type CanonicalChatEventConsumer = Pick<CanonicalChatEventSource, "subscribe">
  & Partial<Pick<CanonicalChatEventSource, "subscribeConnectionState" | "connectionState">>;

function boundedRegistry<T>(options: {
  maxConsumers: number;
  limitMessage: string;
  deliveryFailureMessage: string;
}) {
  const consumers: T[] = [];
  return {
    subscribe(consumer: T) {
      if (consumers.length >= options.maxConsumers) throw new Error(options.limitMessage);
      consumers.push(consumer);
      let subscribed = true;
      return {
        dispose() {
          if (!subscribed) return;
          subscribed = false;
          const index = consumers.indexOf(consumer);
          if (index >= 0) consumers.splice(index, 1);
        },
      };
    },
    notify(deliver: (consumer: T) => void) {
      for (const consumer of [...consumers]) {
        try {
          deliver(consumer);
        } catch (error: unknown) {
          console.warn(options.deliveryFailureMessage, error instanceof Error ? error.name : "UnknownError");
        }
      }
    },
    clear() { consumers.length = 0; },
    size: () => consumers.length,
  };
}

export function createCanonicalChatSseParser(options: {
  maxEventBytes?: number;
  onData(data: string, id?: string): void;
  onActivity(): void;
}): { push(chunk: Uint8Array): void; finish(): void } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const maxEventBytes = Math.max(1, Math.min(options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES, DEFAULT_MAX_EVENT_BYTES));
  let pending = "";
  let eventBytes = 0;
  let dataLines: string[] = [];
  let eventId: string | undefined;

  const resetRecord = () => {
    eventBytes = 0;
    dataLines = [];
    eventId = undefined;
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineBytes = encoder.encode(line).byteLength + 1;
    if (lineBytes > maxEventBytes || eventBytes + lineBytes > maxEventBytes) {
      throw new ChatEventFrameTooLarge();
    }
    eventBytes += lineBytes;
    if (line === "") {
      if (dataLines.length > 0) options.onData(dataLines.join("\n"), eventId);
      resetRecord();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") dataLines.push(value);
    if (field === "id" && !value.includes("\0")) eventId = value;
  };

  const consumeText = (text: string) => {
    pending += text;
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      consumeLine(line);
    }
    if (encoder.encode(pending).byteLength + eventBytes > maxEventBytes) throw new ChatEventFrameTooLarge();
  };

  return {
    push(chunk) {
      if (chunk.byteLength === 0) return;
      options.onActivity();
      consumeText(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      consumeText(decoder.decode());
    },
  };
}

export function createCanonicalChatEventSource(options: {
  openStream(input: { cursor?: number; signal: AbortSignal }): Promise<Response>;
  maxConsumers?: number;
  maxSeenCursors?: number;
  maxReconnectDelayMs?: number;
  inactivityTimeoutMs?: number;
  connectionLifetimeMs?: number;
  setTimeoutFn?: (callback: () => void, delay: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}): CanonicalChatEventSource {
  const maxConsumers = Math.max(1, Math.min(options.maxConsumers ?? DEFAULT_MAX_CONSUMERS, DEFAULT_MAX_CONSUMERS));
  const maxSeenCursors = Math.max(1, Math.min(options.maxSeenCursors ?? DEFAULT_MAX_SEEN_CURSORS, DEFAULT_MAX_SEEN_CURSORS));
  const maxReconnectDelayMs = Math.max(1, Math.min(options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS, DEFAULT_MAX_RECONNECT_DELAY_MS));
  const inactivityTimeoutMs = Math.max(1_000, options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS);
  const connectionLifetimeMs = Math.max(inactivityTimeoutMs, options.connectionLifetimeMs ?? DEFAULT_CONNECTION_LIFETIME_MS);
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const invalidationConsumers = boundedRegistry<(event: CanonicalChatInvalidation) => void>({
    maxConsumers,
    limitMessage: "Chat event consumer limit reached",
    deliveryFailureMessage: "[canonical-chat] event consumer failed:",
  });
  const stateConsumers = boundedRegistry<() => void>({
    maxConsumers,
    limitMessage: "Chat connection-state consumer limit reached",
    deliveryFailureMessage: "[canonical-chat] connection-state consumer failed:",
  });
  const seenCursors = new Map<number, true>();
  let state: CanonicalChatEventConnectionState = "idle";
  let started = false;
  let disposed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown;
  let inactivityTimer: unknown;
  let rotationTimer: unknown;
  let connectionController: AbortController | undefined;
  let connectionReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let connectionGeneration = 0;
  let lastCursor: number | undefined;

  const setState = (next: CanonicalChatEventConnectionState) => {
    if (state === next) return;
    state = next;
    stateConsumers.notify((consumer) => consumer());
  };

  const rememberCursor = (cursor: number) => {
    if (seenCursors.has(cursor)) return false;
    seenCursors.set(cursor, true);
    while (seenCursors.size > maxSeenCursors) {
      const oldest = seenCursors.keys().next().value;
      if (typeof oldest !== "number") break;
      seenCursors.delete(oldest);
    }
    return true;
  };

  const advanceCursor = (cursor: number) => {
    lastCursor = lastCursor === undefined ? cursor : Math.max(lastCursor, cursor);
  };

  const clearConnectionTimers = () => {
    for (const timer of [inactivityTimer, rotationTimer]) {
      if (timer !== undefined) clearTimeoutFn(timer);
    }
    inactivityTimer = undefined;
    rotationTimer = undefined;
  };

  const abortConnection = () => {
    clearConnectionTimers();
    const reader = connectionReader;
    connectionReader = undefined;
    if (reader) {
      void reader.cancel().catch((error: unknown) => {
        console.warn("[canonical-chat] event stream reader cancel failed:", error instanceof Error ? error.name : "UnknownError");
      });
    }
    connectionController?.abort();
    connectionController = undefined;
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) return;
    abortConnection();
    setState("reconnecting");
    const delay = Math.min(250 * (2 ** reconnectAttempt), maxReconnectDelayMs);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };

  const resetInactivityTimer = (generation: number) => {
    if (inactivityTimer !== undefined) clearTimeoutFn(inactivityTimer);
    inactivityTimer = setTimeoutFn(() => {
      if (!disposed && generation === connectionGeneration) scheduleReconnect();
    }, inactivityTimeoutMs);
  };

  const handleData = (raw: string, replay: { complete: boolean; gap: boolean; sawEvent: boolean }) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error: unknown) {
      console.warn("[canonical-chat] event stream sent invalid JSON:", error instanceof Error ? error.name : "UnknownError");
      throw error;
    }
    const parsed = CanonicalChatStreamServerFrameSchema.safeParse(value);
    if (!parsed.success) throw new Error("InvalidChatEventFrame");
    const frame = parsed.data;
    if (frame.type === "chat.stream.attached") {
      reconnectAttempt = 0;
      setState("open");
    } else if (frame.type === "chat.replay.gap") {
      replay.gap = true;
    } else if (frame.type === "chat.replay.end") {
      if (frame.nextCursor !== undefined) advanceCursor(frame.nextCursor);
      if (replay.gap || replay.sawEvent) {
        invalidationConsumers.notify((consumer) => consumer({
          type: "chat.full_refresh",
          ...(frame.nextCursor === undefined ? {} : { cursor: frame.nextCursor }),
        }));
      }
      replay.complete = true;
      replay.gap = false;
    } else if (frame.type === "chat.event") {
      advanceCursor(frame.event.cursor);
      if (!rememberCursor(frame.event.cursor)) return;
      if (!replay.complete) replay.sawEvent = true;
      invalidationConsumers.notify((consumer) => consumer({
        type: "chat.changed",
        chatId: frame.event.chatId,
        cursor: frame.event.cursor,
        revision: frame.event.revision,
        eventType: frame.event.eventType,
      }));
    } else if (frame.type === "chat.stream.closing" || (frame.type === "chat.stream.error" && frame.error.retryable)) {
      scheduleReconnect();
    }
  };

  async function connect(): Promise<void> {
    if (disposed) return;
    const generation = ++connectionGeneration;
    abortConnection();
    const controller = new AbortController();
    connectionController = controller;
    setState(reconnectAttempt === 0 ? "connecting" : "reconnecting");
    let response: Response;
    try {
      response = await options.openStream({
        ...(lastCursor === undefined ? {} : { cursor: lastCursor }),
        signal: controller.signal,
      });
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) {
        throw new Error("InvalidChatEventResponse");
      }
    } catch (error: unknown) {
      if (!disposed && generation === connectionGeneration) {
        console.warn("[canonical-chat] event stream connection unavailable:", error instanceof Error ? error.name : "UnknownError");
        scheduleReconnect();
      }
      return;
    }
    if (disposed || generation !== connectionGeneration) {
      controller.abort();
      return;
    }

    resetInactivityTimer(generation);
    rotationTimer = setTimeoutFn(() => {
      if (!disposed && generation === connectionGeneration) scheduleReconnect();
    }, connectionLifetimeMs);
    const replay = { complete: false, gap: false, sawEvent: false };
    const parser = createCanonicalChatSseParser({
      onActivity: () => resetInactivityTimer(generation),
      onData: (data) => handleData(data, replay),
    });
    const reader = response.body.getReader();
    connectionReader = reader;
    void (async () => {
      try {
        while (!disposed && generation === connectionGeneration) {
          const next = await reader.read();
          if (next.done) break;
          parser.push(next.value);
        }
        parser.finish();
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          console.warn("[canonical-chat] event stream read failed:", error instanceof Error ? error.name : "UnknownError");
        }
      } finally {
        if (connectionReader === reader) connectionReader = undefined;
        try {
          reader.releaseLock();
        } catch (error: unknown) {
          console.warn("[canonical-chat] event stream reader release failed:", error instanceof Error ? error.name : "UnknownError");
        }
        if (!disposed && generation === connectionGeneration) scheduleReconnect();
      }
    })();
  }

  return {
    subscribe(listener) {
      if (disposed) throw new Error("Chat event source is disposed");
      return invalidationConsumers.subscribe(listener);
    },
    subscribeConnectionState(listener) {
      if (disposed) throw new Error("Chat event source is disposed");
      return stateConsumers.subscribe(listener);
    },
    connectionState: () => state,
    async start() {
      if (started || disposed) return;
      started = true;
      await connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      connectionGeneration += 1;
      if (reconnectTimer !== undefined) clearTimeoutFn(reconnectTimer);
      reconnectTimer = undefined;
      abortConnection();
      seenCursors.clear();
      invalidationConsumers.clear();
      setState("disposed");
      stateConsumers.clear();
    },
    activeInvalidationConsumerCount: () => invalidationConsumers.size(),
  };
}
