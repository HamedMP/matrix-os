/** Register onboarding and vocal WebSocket routes with isolated lifecycles. */
import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { createOnboardingHandler } from "../onboarding/ws-handler.js";
import { createReadinessService } from "../onboarding/readiness-service.js";
import type { GeminiLiveConnection } from "../onboarding/gemini-live.js";
import { createVocalHandler } from "../vocal/ws-handler.js";

export interface VoiceWebSocketRouteOptions {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  homePath: string;
  geminiLiveConnection: GeminiLiveConnection;
  readinessService: ReturnType<typeof createReadinessService>;
  captureGatewayProductEvent(event: string, properties?: Record<string, string | number | boolean | undefined>): void;
}

export function registerVoiceWebSocketRoutes(options: VoiceWebSocketRouteOptions): void {
  const { app, upgradeWebSocket, homePath, geminiLiveConnection, readinessService,
    captureGatewayProductEvent } = options;
  // --- Onboarding WebSocket ---
  const onboardingHandler = createOnboardingHandler({
    homePath,
    geminiConnection: geminiLiveConnection,
    geminiModel: process.env.ONBOARDING_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview",
    readinessService,
    ownerId: process.env.MATRIX_USER_ID ?? process.env.MATRIX_HANDLE,
    onFailure: ({ stage, reasonKind }) => {
      captureGatewayProductEvent("onboarding_failed", { stage, reason_kind: reasonKind });
    },
  });

  app.get(
    "/ws/onboarding",
    upgradeWebSocket(() => {
      return {
        onOpen(_evt, ws) {
          try {
            onboardingHandler.activate();
          } catch (err) {
            console.warn("[onboarding] activate failed:", err instanceof Error ? err.message : String(err));
            ws.send(JSON.stringify({ type: "error", code: "connection_limit", stage: "greeting", message: "Another onboarding session is active", retryable: true }));
            ws.close();
            return;
          }
          // onOpen awaits isOnboardingComplete; if that rejects (e.g. fs
          // permission error), we must release the `active` flag and close
          // the socket, otherwise the singleton stays locked and all future
          // connections hang on initial message.
          onboardingHandler.onOpen((msg) => {
            ws.send(JSON.stringify(msg));
          }).catch((err: unknown) => {
            console.warn(
              "[onboarding] onOpen failed:",
              err instanceof Error ? err.message : String(err),
            );
            try {
              ws.send(JSON.stringify({ type: "error", code: "internal", stage: "greeting", message: "onboarding failed to initialize", retryable: true }));
            } catch (sendErr) {
              console.warn(
                "[onboarding] failed to send initialization error:",
                sendErr instanceof Error ? sendErr.message : String(sendErr),
              );
            }
            onboardingHandler.onClose();
            ws.close();
          });
        },
        onMessage(evt, ws) {
          const data = typeof evt.data === "string" ? evt.data : evt.data.toString();
          void onboardingHandler.onMessage(data).catch((err: unknown) => {
            console.warn(
              "[onboarding] onMessage failed:",
              err instanceof Error ? err.message : String(err),
            );
            try {
              ws.send(JSON.stringify({ type: "error", code: "internal", stage: "unknown", message: "Onboarding message failed", retryable: true }));
            } catch (sendErr) {
              console.warn(
                "[onboarding] failed to send message error:",
                sendErr instanceof Error ? sendErr.message : String(sendErr),
              );
            }
            ws.close();
          });
        },
        onClose() {
          onboardingHandler.onClose();
        },
      };
    }),
  );

  // --- Vocal mode WebSocket ---
  // Each connection gets its own isolated handler so multiple users (or
  // reconnecting tabs) don't share a Gemini Live session.
  app.get(
    "/ws/vocal",
    upgradeWebSocket(() => {
      const vocalHandler = createVocalHandler({
        homePath,
        geminiConnection: geminiLiveConnection,
        // VOCAL_GEMINI_MODEL keeps Aoede independently configurable from
        // onboarding; fall back to ONBOARDING_GEMINI_MODEL so existing
        // deployments don't regress until operators set the vocal-specific
        // var.
        geminiModel:
          process.env.VOCAL_GEMINI_MODEL ??
          process.env.ONBOARDING_GEMINI_MODEL ??
          "gemini-3.1-flash-live-preview",
      });
      return {
        onOpen(_evt, ws) {
          vocalHandler.onOpen((msg) => {
            ws.send(JSON.stringify(msg));
          });
        },
        onMessage(evt, ws) {
          const data = typeof evt.data === "string" ? evt.data : evt.data.toString();
          void vocalHandler.onMessage(data).catch((err: unknown) => {
            console.warn(
              "[vocal] onMessage failed:",
              err instanceof Error ? err.message : String(err),
            );
            try {
              ws.send(JSON.stringify({ type: "error", message: "Voice message failed", retryable: true }));
            } catch (sendErr) {
              console.warn(
                "[vocal] failed to send message error:",
                sendErr instanceof Error ? sendErr.message : String(sendErr),
              );
            }
            ws.close();
          });
        },
        onClose() {
          vocalHandler.onClose();
        },
      };
    }),
  );

}
