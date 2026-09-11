import { ChatMessageWireVersionSchema, projectChatMessageFrame } from "@matrix-os/contracts";
import { CanonicalChatEventCursorSchema, type CanonicalChatTransportFrame } from "@matrix-os/contracts";
import { type Context, type Hono } from "hono";
import type { RequestPrincipal } from "../request-principal.js";
import type {
  CanonicalChatEventStreamSession,
  createCanonicalChatEventStream,
} from "./event-stream.js";

const MAX_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_CHUNKS = 320;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const CURSOR_TEXT = /^(0|[1-9]\d*)$/;

function parseCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!CURSOR_TEXT.test(value)) throw new Error("InvalidCursor");
  return CanonicalChatEventCursorSchema.parse(Number(value));
}

function acceptsEventStream(value: string | undefined): boolean {
  return value?.split(",").some((entry) => entry.trim().split(";", 1)[0]?.toLowerCase() === "text/event-stream") ?? false;
}

function encodeFrame(encoder: TextEncoder, frame: CanonicalChatTransportFrame): Uint8Array {
  const json = JSON.stringify(frame);
  if (encoder.encode(json).byteLength > (frame.type === "chat.content" ? 512 * 1024 - 1024 : MAX_FRAME_BYTES)) throw new Error("FrameTooLarge");
  const id = frame.type === "chat.event" || frame.type === "chat.content" ? `id: ${frame.event.cursor}\n` : "";
  return encoder.encode(`${id}data: ${json}\n\n`);
}

export function registerCanonicalChatEventHttpRoute(options: {
  app: Hono;
  stream: Pick<ReturnType<typeof createCanonicalChatEventStream>, "open">;
  getPrincipal(context: Context): RequestPrincipal;
  heartbeatIntervalMs?: number;
  setIntervalFn?: (callback: () => void, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
}): void {
  const heartbeatIntervalMs = Math.max(1_000, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  const setIntervalFn = options.setIntervalFn ?? ((callback, delay) => setInterval(callback, delay));
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));

  options.app.get("/api/chats/events", (context) => {
    if (!acceptsEventStream(context.req.header("accept"))) {
      return context.json({ error: "Event stream required" }, 406);
    }

    let cursor: number | undefined;
    try {
      const lastEventId = context.req.header("last-event-id");
      cursor = parseCursor(lastEventId === undefined ? context.req.query("cursor") : lastEventId);
    } catch (error: unknown) {
      if (!(error instanceof Error)) console.warn("[chat/event-http-route] Cursor validation failed: UnknownError");
      return context.json({ error: "Invalid stream cursor" }, 400);
    }

    const messageVersion = ChatMessageWireVersionSchema.safeParse(context.req.query("messageVersion"));
    if (!messageVersion.success) return context.json({ error: "Unsupported message version" }, 400);
    const encoder = new TextEncoder();
    const principal = options.getPrincipal(context);
    const protocol = context.req.header("x-matrix-chat-protocol");
    if (protocol !== undefined && protocol !== "1" && protocol !== "2") return context.json({ error: "Unsupported stream protocol" }, 400);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let session: CanonicalChatEventStreamSession | undefined;
    let heartbeatTimer: unknown;
    let closed = false;

    const close = (cancelled = false): void => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer !== undefined) {
        clearIntervalFn(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      session?.onClose();
      if (cancelled) return;
      try {
        controller.close();
      } catch (error: unknown) {
        console.warn("[chat/event-http-route] Response close failed:", error instanceof Error ? error.name : "UnknownError");
      }
    };

    const body = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
      cancel() {
        close(true);
      },
    }, protocol === "2" ? new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 })
      : new CountQueuingStrategy({ highWaterMark: MAX_PENDING_CHUNKS }));

    const sink = {
      send(frame: CanonicalChatTransportFrame): boolean {
        if (closed || (controller.desiredSize ?? 0) <= 0) return false;
        try {
          controller.enqueue(encodeFrame(encoder, projectChatMessageFrame(frame, messageVersion.data)));
          return true;
        } catch (error: unknown) {
          console.warn("[chat/event-http-route] Frame enqueue failed:", error instanceof Error ? error.name : "UnknownError");
          return false;
        }
      },
      close,
    };

    void Promise.resolve()
      .then(() => closed
        ? undefined
        : options.stream.open({
            sink,
            principal,
            ...(protocol === "2" ? { content: true } : {}),
            ...(cursor === undefined ? {} : { cursor }),
          }))
      .then((opened) => {
        if (!opened) return;
        session = opened;
        if (closed) {
          opened.onClose();
          return;
        }
        heartbeatTimer = setIntervalFn(() => {
          if (closed || (controller.desiredSize ?? 0) <= 0) {
            close();
            return;
          }
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            session?.touch();
          } catch (error: unknown) {
            console.warn("[chat/event-http-route] Heartbeat failed:", error instanceof Error ? error.name : "UnknownError");
            close();
          }
        }, heartbeatIntervalMs);
      })
      .catch((error: unknown) => {
        console.warn("[chat/event-http-route] Attach failed:", error instanceof Error ? error.name : "UnknownError");
        sink.send({
          type: "chat.stream.error",
          error: {
            code: "chat_stream_unavailable",
            safeMessage: "Chat updates are temporarily unavailable.",
            retryable: true,
            recoveryActions: ["retry"],
          },
        });
        close();
      });

    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  });
}
