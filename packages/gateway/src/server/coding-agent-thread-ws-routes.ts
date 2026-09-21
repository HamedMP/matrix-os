/** Register coding-agent thread stream WebSocket with bounded pending frames. */
import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { createCodingAgentThreadStream, threadStreamFrameDataToString } from "../coding-agents/thread-stream.js";
import { requireRequestPrincipal } from "../request-principal.js";

export interface CodingAgentThreadWebSocketRouteOptions {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  codingAgentThreadStream: ReturnType<typeof createCodingAgentThreadStream> | undefined;
  logBestEffortFailure(context: string, error: unknown): void;
  logUnexpectedWsSendFailure(context: string, error: unknown): void;
}

export function registerCodingAgentThreadWebSocketRoutes(options: CodingAgentThreadWebSocketRouteOptions): void {
  const { app, upgradeWebSocket, codingAgentThreadStream, logBestEffortFailure,
    logUnexpectedWsSendFailure } = options;
  if (codingAgentThreadStream) {
    app.get(
      "/ws/coding-agents/thread/:threadId",
      upgradeWebSocket((c) => {
        const threadId = c.req.param("threadId") ?? "";
        const cursor = c.req.query("cursor");
        let streamHandle: { onMessage(raw: string): void; onClose(): void } | null = null;
        let socketClosed = false;
        const pendingFrames: string[] = [];
        const pendingLimit = 8;

        return {
          onOpen(_evt, ws) {
            let principal;
            try {
              principal = requireRequestPrincipal(c);
            } catch (err: unknown) {
              logBestEffortFailure("Coding agent thread stream principal rejected", err);
              try {
                ws.send(JSON.stringify({
                  type: "thread.stream.error",
                  error: {
                    code: "thread_stream_unavailable",
                    safeMessage: "Thread stream is temporarily unavailable. Try again.",
                    retryable: true,
                    recoveryActions: ["retry"],
                  },
                }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Coding agent thread WebSocket rejected error send failed", sendErr);
              }
              ws.close();
              return;
            }

            void codingAgentThreadStream.open({
              ws,
              principal,
              threadId,
              cursor,
            }).then((session) => {
              if (socketClosed) {
                session.onClose();
                return;
              }
              streamHandle = session;
              for (const frame of pendingFrames.splice(0)) {
                session.onMessage(frame);
              }
            }).catch((err: unknown) => {
              logBestEffortFailure("Coding agent thread stream attach failed", err);
              pendingFrames.splice(0);
              if (socketClosed) return;
              try {
                ws.send(JSON.stringify({
                  type: "thread.stream.error",
                  error: {
                    code: "thread_stream_unavailable",
                    safeMessage: "Thread stream is temporarily unavailable. Try again.",
                    retryable: true,
                    recoveryActions: ["retry"],
                  },
                }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Coding agent thread WebSocket send failed", sendErr);
              }
              ws.close();
            });
          },
          onMessage(evt, ws) {
            const raw = threadStreamFrameDataToString(evt.data);
            if (raw === null) return;
            if (streamHandle) {
              streamHandle.onMessage(raw);
              return;
            }
            if (pendingFrames.length >= pendingLimit) {
              try {
                ws.send(JSON.stringify({
                  type: "thread.stream.error",
                  error: {
                    code: "invalid_frame",
                    safeMessage: "Stream message was invalid. Refresh and try again.",
                    retryable: true,
                    recoveryActions: ["retry"],
                  },
                }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Coding agent thread WebSocket send failed", sendErr);
              }
              ws.close();
              return;
            }
            pendingFrames.push(raw);
          },
          onClose() {
            socketClosed = true;
            pendingFrames.splice(0);
            streamHandle?.onClose();
            streamHandle = null;
          },
        };
      }),
    );
  }

}
