/** Register owner canvas HTTP and authenticated realtime routes. */
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { CanvasIdSchema } from "../canvas/contracts.js";
import { createCanvasRoutes } from "../canvas/routes.js";
import type { CanvasService } from "../canvas/service.js";
import type { CanvasSubscriptionHub } from "../canvas/subscriptions.js";
import type { GatewayCollaborationRuntime } from "../collaboration/wiring.js";
import { requireRequestPrincipal } from "../request-principal.js";

export interface CanvasGatewayRouteOptions {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  canvasService: CanvasService | null;
  canvasSubscriptionHub: CanvasSubscriptionHub | null;
  gatewayCollaboration: GatewayCollaborationRuntime | null;
  logUnexpectedWsSendFailure(context: string, error: unknown): void;
}

export function registerCanvasGatewayRoutes(options: CanvasGatewayRouteOptions): void {
  const { app, upgradeWebSocket, canvasService, canvasSubscriptionHub,
    gatewayCollaboration, logUnexpectedWsSendFailure } = options;
  if (canvasService) {
    // Global authMiddleware is mounted before route registration; routes still resolve user IDs defensively.
    app.route("/api/canvases", createCanvasRoutes({
      service: canvasService,
      getUserId: (c) => requireRequestPrincipal(c).userId,
      broadcastCanvasUpdate: (canvasId, message) => canvasSubscriptionHub?.broadcast(canvasId, message),
      ...(gatewayCollaboration ? {
        projectOperationAdmission: gatewayCollaboration.projectOperationAdmission,
      } : {}),
    }));

    app.get(
      "/api/canvases/:canvasId/ws",
      upgradeWebSocket((c) => {
        const connectionId = `canvas_${randomBytes(12).toString("hex")}`;
        let canvasId: string;
        let userId: string;
        try {
          canvasId = CanvasIdSchema.parse(c.req.param("canvasId"));
          userId = requireRequestPrincipal(c).userId;
        } catch (err: unknown) {
          console.error("[canvas/ws] Upgrade rejected:", err instanceof Error ? err.message : String(err));
          return {
            onOpen(_evt, ws) {
              try {
                ws.send(JSON.stringify({ type: "error", error: "Canvas realtime failed" }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Canvas WebSocket rejected error send failed", sendErr);
              } finally {
                ws.close();
              }
            },
          };
        }

        return {
          async onOpen(_evt, ws) {
            try {
              await canvasSubscriptionHub?.subscribe({
                connectionId,
                canvasId,
                userId,
                send: (message) => {
                  try {
                    ws.send(message);
                  } catch (err: unknown) {
                    logUnexpectedWsSendFailure("Canvas WebSocket send failed", err);
                  }
                },
              });
              ws.send(JSON.stringify({ type: "canvas:subscribed", canvasId }));
            } catch (err: unknown) {
              console.error("[canvas/ws] Subscribe failed:", err instanceof Error ? err.message : String(err));
              try {
                ws.send(JSON.stringify({ type: "error", error: "Canvas realtime failed" }));
              } catch (sendErr: unknown) {
                logUnexpectedWsSendFailure("Canvas WebSocket error send failed", sendErr);
              } finally {
                ws.close();
              }
            }
          },
          onMessage(evt) {
            try {
              const parsed = canvasSubscriptionHub?.validateInboundFrame(
                typeof evt.data === "string" ? evt.data : "",
              );
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                (parsed as { type?: unknown }).type === "presence"
              ) {
                canvasSubscriptionHub?.updatePresence(
                  connectionId,
                  canvasSubscriptionHub.validatePresenceFrame(parsed),
                );
              }
            } catch (err: unknown) {
              canvasSubscriptionHub?.sendSafeError(connectionId, err);
            }
          },
          onClose() {
            canvasSubscriptionHub?.unsubscribe(connectionId);
          },
        };
      }),
    );
  } else {
    app.all("/api/canvases/*", (c) => c.json({ error: "Database not configured (no DATABASE_URL)" }, 503));
    app.all("/api/canvases", (c) => c.json({ error: "Database not configured (no DATABASE_URL)" }, 503));
  }

}
