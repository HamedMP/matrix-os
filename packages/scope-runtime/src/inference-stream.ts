import { INFERENCE_RESPONSE_BUFFER_MAX_BYTES, INFERENCE_RESPONSE_FRAME_MAX_BYTES, INFERENCE_RESPONSE_STREAM_FRAME_MAX_BYTES } from "@matrix-os/contracts";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import {
  ScopeRuntimeBrokerResponseSchema,
  ScopeRuntimeInferenceStreamFrameSchema,
} from "./broker-protocol.js";

const STREAM_HEADER = "x-matrix-inference-stream";

/** Find one complete SSE event without changing the bytes forwarded to the SDK. */
function eventEnd(input: string): number {
  let offset = 0;
  while (offset < input.length) {
    let end = offset;
    while (end < input.length && input[end] !== "\n" && input[end] !== "\r") end++;
    if (end === input.length || (input[end] === "\r" && end + 1 === input.length)) return -1;
    const next = end + (input[end] === "\r" && input[end + 1] === "\n" ? 2 : 1);
    if (end === offset) return next;
    offset = next;
  }
  return -1;
}

function eventKind(event: string): "ordinary" | "terminal" | "error" {
  const lines = event.replace(/\r\n?|\n/g, "\n").split("\n");
  let name = "";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  const body = data.join("\n").trim();
  if (name === "error" || name === "response.failed" || name === "response.incomplete") return "error";
  if (body === "[DONE]") return "terminal";
  let payload: unknown;
  try { payload = JSON.parse(body); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    // A non-JSON SSE event is SDK-owned.
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record.type === "error" || record.type === "response.failed" || record.type === "response.incomplete"
      || record.error != null) return "error";
    if (record.type === "response.completed" || record.type === "message_stop"
      || (Array.isArray(record.choices) && record.choices.some(choice =>
        choice && typeof choice === "object" && "finish_reason" in choice && choice.finish_reason != null))) return "terminal";
  }
  return name === "response.completed" || name === "message_stop" ? "terminal" : "ordinary";
}

/** Hold only terminal SSE events and following bytes; ordinary events drain incrementally. */
class SseTerminalGate {
  private pending = "";
  private held = "";
  private terminal = false;
  private sawEvent = false;

  constructor(private readonly write: (value: string) => Promise<void>, private readonly allowPlainBody = false) {}

  async push(body: string): Promise<void> {
    this.pending += body;
    let end: number;
    while ((end = eventEnd(this.pending)) >= 0) {
      const event = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      if (Buffer.byteLength(event) > INFERENCE_RESPONSE_BUFFER_MAX_BYTES) {
        throw new Error("Broker inference SSE event exceeded capacity");
      }
      this.sawEvent = true;
      const kind = eventKind(event);
      if (this.terminal && kind === "error") throw new Error("Broker inference error after completion");
      if (this.terminal || kind === "terminal") {
        this.terminal = true;
        this.held += event;
        if (Buffer.byteLength(this.held) > INFERENCE_RESPONSE_BUFFER_MAX_BYTES) {
          throw new Error("Broker inference terminal buffer exceeded capacity");
        }
      } else {
        await this.write(event);
      }
    }
    if (Buffer.byteLength(this.pending) > INFERENCE_RESPONSE_BUFFER_MAX_BYTES
      || (this.terminal && Buffer.byteLength(this.held) + Buffer.byteLength(this.pending) > INFERENCE_RESPONSE_BUFFER_MAX_BYTES)) {
      throw new Error("Broker inference SSE event exceeded capacity");
    }
  }

  async finish(): Promise<void> {
    const sseField = /(?:^|[\r\n])(?:data|event|id|retry)(?::|[\r\n]|$)|(?:^|[\r\n]):/;
    if (this.pending.trim() && (!this.allowPlainBody || this.sawEvent || sseField.test(this.pending))) {
      throw new Error("Incomplete broker inference SSE event");
    }
    await this.write(this.held + this.pending);
  }
}

/** One broker inference reply, forwarded with HTTP and Unix socket backpressure. */
export async function brokerStreamRequest(
  socketPath: string,
  request: Record<string, unknown> & { requestId: string },
  response: ServerResponse,
  timeoutMs: number,
): Promise<void> {
  const socket = connect({ path: socketPath });
  const cancelled = new AbortController();
  const onClientClose = () => {
    if (!complete) {
      cancelled.abort();
      socket.destroy();
    }
  };
  let complete = false;
  let started = false;
  let seenEnd = false;
  let sequence = 0;
  let line = Buffer.alloc(0);
  let sse: SseTerminalGate | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const write = async (body: string) => {
    if (body && !response.write(body)) await once(response, "drain", { signal: cancelled.signal });
  };
  response.once("close", onClientClose);
  const timeout = setTimeout(() => {
    cancelled.abort();
    socket.destroy(new Error("Broker timed out"));
  }, timeoutMs);
  timeout.unref?.();

  async function accept(bytes: Buffer): Promise<void> {
    if (seenEnd) throw new Error("Trailing broker inference frame");
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch (error: unknown) {
      throw new Error("Invalid broker inference frame", { cause: error });
    }
    const parsed = ScopeRuntimeInferenceStreamFrameSchema.safeParse(raw);
    if (parsed.success) {
      if (bytes.length > INFERENCE_RESPONSE_STREAM_FRAME_MAX_BYTES) throw new Error("Broker inference frame exceeded capacity");
      const frame = parsed.data;
      if (frame.requestId !== request.requestId) throw new Error("Wrong broker inference request");
      if (frame.stream === "start") {
        if (started) throw new Error("Duplicate broker inference start");
        started = true;
        timeout.refresh();
        sse = new SseTerminalGate(write);
        response.writeHead(frame.status, { ...frame.headers, [STREAM_HEADER]: "1" });
        response.flushHeaders();
        return;
      }
      if (!started || frame.sequence !== sequence) throw new Error("Out-of-order broker inference frame");
      if (frame.stream === "end") {
        seenEnd = true;
        return;
      }
      sequence++;
      if (sse) await sse.push(frame.body);
      else await write(frame.body);
      return;
    }
    if (started) throw new Error("Invalid broker inference stream frame");
    const legacy = ScopeRuntimeBrokerResponseSchema.safeParse(raw);
    if (!legacy.success || legacy.data.requestId !== request.requestId || !legacy.data.ok) {
      throw new Error("Broker inference failed");
    }
    seenEnd = true;
    sse = new SseTerminalGate(write, true);
    response.writeHead(legacy.data.status, legacy.data.headers);
    if (sse) await sse.push(legacy.data.body);
    else await write(legacy.data.body);
  }

  try {
    // Keep the write half open so a cancelled HTTP reader closes the broker
    // connection immediately, even while the gateway is waiting upstream.
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    for await (const chunk of socket) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Before start this bounds setup; afterwards the same watchdog bounds
      // each wait for broker bytes without capping a progressing stream.
      if (started && bytes.length) timeout.refresh();
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const piece = bytes.subarray(offset, newline < 0 ? bytes.length : newline);
        if (line.length + piece.length > INFERENCE_RESPONSE_FRAME_MAX_BYTES) {
          throw new Error("Broker inference frame exceeded capacity");
        }
        line = Buffer.concat([line, piece], line.length + piece.length);
        if (seenEnd) throw new Error("Trailing broker inference bytes");
        // The canonical legacy serializer puts `ok` before its large body.
        const legacy = !started && /^\{"version":1,"requestId":"[0-9a-f-]{36}","ok":(?:true|false)[,}]/
          .test(line.subarray(0, 96).toString("utf8"));
        if (!legacy && line.length > INFERENCE_RESPONSE_STREAM_FRAME_MAX_BYTES) {
          throw new Error("Broker inference frame exceeded capacity");
        }
        if (newline < 0) break;
        await accept(line);
        line = Buffer.alloc(0);
        offset = newline + 1;
      }
    }
    if (!seenEnd || line.length || cancelled.signal.aborted || response.destroyed) {
      throw new Error("Broker inference ended without completion");
    }
    if (sse) await sse.finish();
    complete = true;
    response.end();
  } finally {
    clearTimeout(timeout);
    response.off("close", onClientClose);
    socket.destroy();
  }
}
