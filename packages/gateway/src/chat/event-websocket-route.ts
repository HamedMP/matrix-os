import { CanonicalChatEventCursorSchema } from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { z } from "zod/v4";
import type { RequestPrincipal } from "../request-principal.js";
import type { CanonicalChatEventStreamSession, createCanonicalChatEventStream } from "./event-stream.js";

const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }).strict(),
  z.object({ type: z.literal("detach") }).strict(),
]);

/** Compatibility transport for clients shipped before HTTP streaming. */
export function registerCanonicalChatEventWebSocketRoute(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  stream: Pick<ReturnType<typeof createCanonicalChatEventStream>, "open">;
  getPrincipal(context: Context): RequestPrincipal;
}): void {
  options.app.get("/ws/chats/events", options.upgradeWebSocket((context) => {
    const principal = options.getPrincipal(context);
    let session: CanonicalChatEventStreamSession | undefined;
    let closed = false;
    const close = (ws: WSContext): void => {
      if (closed) return;
      closed = true;
      session?.onClose();
      ws.close();
    };
    return {
      async onOpen(_event, ws) {
        try {
          const rawCursor = context.req.query("cursor");
          if (rawCursor !== undefined && !/^(0|[1-9]\d*)$/.test(rawCursor)) throw new Error("InvalidCursor");
          const cursor = rawCursor === undefined ? undefined : CanonicalChatEventCursorSchema.parse(Number(rawCursor));
          const opened = await options.stream.open({ principal, cursor, sink: {
            send(frame) {
              if (closed || frame.type === "chat.content") return false;
              const raw = ws.raw as { bufferedAmount?: number } | undefined;
              if ((raw?.bufferedAmount ?? 0) > 256 * 1024) return false;
              ws.send(JSON.stringify(frame));
              return true;
            },
            close: () => close(ws),
          } });
          if (closed) opened.onClose();
          else session = opened;
        } catch (error: unknown) {
          console.warn("[chat/event-websocket-route] Attach failed:", error instanceof Error ? error.name : "UnknownError");
          close(ws);
        }
      },
      onMessage(event, ws) {
        if (closed) return;
        try {
          const data = event.data;
          // Legacy clients send JSON text frames only; no unbounded binary decoding.
          if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > 4096) throw new Error("InvalidFrame");
          const frame = ClientFrame.parse(JSON.parse(data));
          if (frame.type === "detach") close(ws);
          else {
            session?.touch();
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch (error: unknown) {
          console.warn("[chat/event-websocket-route] Invalid frame:", error instanceof Error ? error.name : "UnknownError");
          close(ws);
        }
      },
      onClose() { closed = true; session?.onClose(); session = undefined; },
      onError(_event, ws) { close(ws); },
    };
  }));
}
