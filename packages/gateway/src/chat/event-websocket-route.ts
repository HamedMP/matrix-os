import { type Context, type Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { RequestPrincipal } from "../request-principal.js";
import {
  canonicalChatEventFrameDataWithinLimit,
  canonicalChatEventFrameWithinLimit,
  chatEventFrameDataToString,
  type CanonicalChatEventStreamSession,
  type createCanonicalChatEventStream,
} from "./event-stream.js";
import { registerCanonicalChatEventRoute } from "./routes.js";

const MAX_PENDING_FRAMES = 8;

function sendSafeStreamError(
  ws: { send(data: string): void },
  code: "invalid_frame" | "stream_unavailable",
): void {
  try {
    ws.send(JSON.stringify({
      type: "chat.stream.error",
      error: code === "invalid_frame"
        ? {
          code,
          safeMessage: "Stream message was invalid. Refresh and try again.",
          retryable: true,
          recoveryActions: ["retry"],
        }
        : {
          code,
          safeMessage: "Chat stream is temporarily unavailable. Try again.",
          retryable: true,
          recoveryActions: ["retry"],
        },
    }));
  } catch (error: unknown) {
    console.warn(
      "[chat/event-websocket-route] Safe error send failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

export function registerCanonicalChatEventWebSocketRoute(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  stream: Pick<ReturnType<typeof createCanonicalChatEventStream>, "open">;
  getPrincipal(context: Context): RequestPrincipal;
}): void {
  registerCanonicalChatEventRoute({
    mount(path, open) {
      options.app.get(path, options.upgradeWebSocket((context) => {
        let session: CanonicalChatEventStreamSession | null = null;
        let socketClosed = false;
        const pendingFrames: string[] = [];

        return {
          onOpen(_event, ws) {
            void open({
              context,
              ws,
              cursor: context.req.query("cursor"),
            }).then((opened) => {
              if (socketClosed) {
                opened.onClose();
                return;
              }
              session = opened;
              for (const frame of pendingFrames.splice(0)) opened.onMessage(frame);
            }).catch((error: unknown) => {
              console.warn(
                "[chat/event-websocket-route] Attach failed:",
                error instanceof Error ? error.name : "UnknownError",
              );
              pendingFrames.splice(0);
              if (socketClosed) return;
              sendSafeStreamError(ws, "stream_unavailable");
              ws.close();
            });
          },
          onMessage(event, ws) {
            if (!canonicalChatEventFrameDataWithinLimit(event.data)) {
              sendSafeStreamError(ws, "invalid_frame");
              ws.close();
              return;
            }
            const raw = chatEventFrameDataToString(event.data);
            if (raw === null) {
              sendSafeStreamError(ws, "invalid_frame");
              ws.close();
              return;
            }
            if (session) {
              session.onMessage(raw);
              return;
            }
            if (!canonicalChatEventFrameWithinLimit(raw) || pendingFrames.length >= MAX_PENDING_FRAMES) {
              sendSafeStreamError(ws, "invalid_frame");
              ws.close();
              return;
            }
            pendingFrames.push(raw);
          },
          onClose() {
            socketClosed = true;
            pendingFrames.splice(0);
            session?.onClose();
            session = null;
          },
        };
      }));
    },
    getPrincipal: (context) => options.getPrincipal(context as Context),
    stream: options.stream,
  });
}
