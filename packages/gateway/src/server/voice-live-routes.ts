import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { ChatRepository } from "../chat/repository.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import type { RequestPrincipal } from "../request-principal.js";
import { hasGeminiLiveConnection, type GeminiLiveConnection } from "../onboarding/gemini-live.js";
import { createGeminiCompanionAdapter, GEMINI_COMPANION_MODEL } from "../live-companion/gemini-adapter.js";
import { createCanonicalLivePort } from "../live-companion/task-broker.js";
import { matrixPiSelection, resolveVoiceChat } from "../live-companion/voice-chat.js";
import { createVoiceLiveHandler } from "../live-companion/voice-live-handler.js";

export const VOICE_LIVE_WS_PATH = "/ws/voice/live";
const QuerySchema = z.object({ chatId: CanonicalChatIdSchema.optional() }).strict();
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{2,80}$/;

/** Native Gemini Live companion on the owner's Matrix Pi Chat. Gateway query
 * token auth covers the upgrade; delegated work runs as ordinary Chat turns. */
export function registerVoiceLiveRoutes(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  connection: GeminiLiveConnection;
  chatRepository: ChatRepository | null;
  getOrchestrator(): CanonicalChatOrchestrator | null;
  getCatalog(principal: RequestPrincipal): Promise<CanonicalProviderCatalog>;
  getPrincipal(c: Context): RequestPrincipal;
  env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  const repository = options.chatRepository;
  const configuredModel = env.MATRIX_VOICE_LIVE_MODEL?.trim();
  const model = configuredModel && MODEL_ID.test(configuredModel) ? configuredModel : GEMINI_COMPANION_MODEL;
  const enabled = env.MATRIX_VOICE_LIVE !== "0" && hasGeminiLiveConnection(options.connection) && repository !== null;
  const handler = repository ? createVoiceLiveHandler({
    adapter: createGeminiCompanionAdapter({ connection: options.connection, model }),
    limits: { maxSessionMs: 30 * 60_000, idleMs: 90_000 },
    resolveChat: (principal, chatId) => resolveVoiceChat({ repository, principal, ...(chatId ? { chatId } : {}),
      piSelection: async () => matrixPiSelection(await options.getCatalog(principal)) }),
    createPort: (principal, target) => {
      const orchestrator = options.getOrchestrator();
      return createCanonicalLivePort({ repository, principal, chatId: target.chatId, selection: orchestrator ? target.selection : undefined,
        orchestrator: orchestrator ?? { admitTurn: async () => { throw new Error("Chat orchestrator unavailable"); } } });
    },
  }) : null;

  options.app.get("/api/voice/live/status", (c) => {
    options.getPrincipal(c);
    return c.json({ available: enabled && options.getOrchestrator() !== null });
  });

  options.app.get(VOICE_LIVE_WS_PATH, options.upgradeWebSocket((c) => {
    let connection: ReturnType<NonNullable<typeof handler>["connect"]> | null = null;
    return {
      onOpen(_event, ws) {
        const query = QuerySchema.safeParse(c.req.query());
        let principal: RequestPrincipal | null = null;
        try { principal = options.getPrincipal(c); }
        catch (error: unknown) { console.warn("[voice-live] principal unavailable", error instanceof Error ? error.name : "UnknownError"); }
        if (!enabled || !handler || !principal || !query.success) {
          ws.send(JSON.stringify({ type: "error", code: !principal ? "unauthorized" : query.success ? "voice_unavailable" : "invalid_request", retryable: false }));
          ws.close();
          return;
        }
        connection = handler.connect(principal, query.data, { send: text => ws.send(text), close: () => ws.close() });
      },
      onMessage(event) {
        const raw = typeof event.data === "string" ? event.data : null;
        if (raw === null) return;
        void connection?.message(raw).catch((error: unknown) => {
          console.warn("[voice-live] message failed", error instanceof Error ? error.name : "UnknownError");
        });
      },
      onClose() {
        void connection?.closed().catch((error: unknown) => {
          console.warn("[voice-live] close failed", error instanceof Error ? error.name : "UnknownError");
        });
      },
    };
  }));

  return { close: async () => { await handler?.closeAll(); } };
}
