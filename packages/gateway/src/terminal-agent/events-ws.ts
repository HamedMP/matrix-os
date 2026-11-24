import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod/v4";
import { TerminalTabIdSchema, TerminalWorkspaceIdSchema, type TeamTerminalOwnerEntry } from "@matrix-os/contracts";
import { readPreviewTerminalOwner } from "../auth.js";
import type { RequestPrincipal } from "../request-principal.js";
import { terminalRuntimeOwnerAccess } from "../shell/workspace-routes.js";
import type { TerminalEventHub, TerminalEventSubscription } from "./events.js";

export const TERMINAL_EVENTS_WS_PATH = "/ws/terminal/events";
const MAX_CLIENT_FRAME_CHARS = 256;
const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }).strict(),
  // The person opened this tab (spec 2706). Sent only by clients that received an `attention` frame.
  z.object({
    type: z.literal("seen"),
    ref: z.object({ workspaceId: TerminalWorkspaceIdSchema, tabId: TerminalTabIdSchema }).strict(),
  }).strict(),
]);

/**
 * `/ws/terminal/events`: the live terminal fact stream for the terminal owner.
 * Clients send `{type:"ping"}` at least every 30 s, and `{type:"seen",ref}` when
 * the person opens a tab; anything else closes the socket.
 */
export function registerTerminalEventWebSocket(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  hub: TerminalEventHub;
  getPrincipal(context: Context): RequestPrincipal;
  terminalOwnerIds: readonly string[];
  /** Spec 2710: team terminal presence for the owner; its service drops the listener on shutdown. */
  teamTerminals?(): { onOwnerEntries(listener: (entries: TeamTerminalOwnerEntry[]) => void): () => void } | undefined;
}): void {
  options.teamTerminals?.()?.onOwnerEntries((entries) => options.hub.publishTeam(entries));
  options.app.get(TERMINAL_EVENTS_WS_PATH, options.upgradeWebSocket((c) => {
    let handle: TerminalEventSubscription | null = null;
    return {
      onOpen(_event, ws) {
        let access: ReturnType<typeof terminalRuntimeOwnerAccess>;
        try {
          access = terminalRuntimeOwnerAccess(options.getPrincipal(c), options.terminalOwnerIds, readPreviewTerminalOwner(c));
        } catch (error: unknown) {
          console.warn("[gateway] terminal events principal unavailable", error instanceof Error ? error.name : "unknown_error");
          access = "not_found";
        }
        if (access !== "allowed") {
          ws.send(JSON.stringify({ type: "error", code: access === "unavailable" ? "unavailable" : "not_found" }));
          ws.close(1008, "Terminal events unavailable");
          return;
        }
        try {
          handle = options.hub.subscribe({
            send: (frame) => ws.send(JSON.stringify(frame)),
            close: () => ws.close(1001, "Terminal events closed"),
            backlog: () => {
              const raw = ws.raw as { bufferedAmount?: unknown } | undefined;
              return typeof raw?.bufferedAmount === "number" ? raw.bufferedAmount : 0;
            },
          });
        } catch (error: unknown) {
          console.warn("[gateway] terminal events subscribe refused", error instanceof Error ? error.message : "unknown_error");
          ws.send(JSON.stringify({ type: "error", code: "capacity" }));
          ws.close(1013, "Terminal events busy");
        }
      },
      onMessage(event, ws) {
        const raw = typeof event.data === "string" ? event.data : null;
        let parsed: z.infer<typeof ClientFrameSchema> | null = null;
        if (raw !== null && raw.length <= MAX_CLIENT_FRAME_CHARS) {
          try { parsed = ClientFrameSchema.safeParse(JSON.parse(raw)).data ?? null; }
          catch (error: unknown) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
        if (!parsed) {
          ws.close(1003, "Invalid message");
          return;
        }
        handle?.touch();
        // A seen mark changes the attention frame every subscriber receives; it has no reply of its own.
        if (parsed.type === "seen") {
          handle?.markSeen(parsed.ref);
          return;
        }
        ws.send(JSON.stringify({ type: "pong" }));
      },
      onClose() {
        handle?.close();
        handle = null;
      },
    };
  }));
}
