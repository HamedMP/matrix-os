import type { RequestPrincipal } from "../request-principal.js";
import type { VoiceMediaAdapter } from "../voice-session/adapter.js";
import type { LiveCompanionPort } from "./coordinator.js";
import type { VoiceChatTarget } from "./voice-chat.js";
import { createVoiceLiveSession, type VoiceLiveSession } from "./voice-live-session.js";

export interface VoiceLiveSocket { send(text: string): void; close(): void }

interface ActiveCall { session: VoiceLiveSession; socket: VoiceLiveSocket }

function safeCode(error: unknown): string {
  if (error instanceof Error && error.name === "ChatNotFoundError") return "chat_unavailable";
  return "provider_unavailable";
}

/** Owner-scoped registry: one live call per owner, a bounded number of owners,
 * and an explicit drain for gateway shutdown. */
export function createVoiceLiveHandler(options: {
  adapter: VoiceMediaAdapter;
  resolveChat(principal: RequestPrincipal, chatId: string | undefined): Promise<VoiceChatTarget>;
  createPort(principal: RequestPrincipal, target: VoiceChatTarget): LiveCompanionPort;
  limits: { maxSessionMs: number; idleMs: number };
  maxSessions?: number;
}) {
  const maxSessions = options.maxSessions ?? 8;
  const calls = new Map<string, ActiveCall>();
  let pendingStarts = 0;

  return {
    get activeCount() { return calls.size; },
    connect(principal: RequestPrincipal, query: { chatId?: string }, socket: VoiceLiveSocket) {
      let session: VoiceLiveSession | null = null;
      let socketClosed = false;
      const write = (frame: Record<string, unknown>) => {
        if (socketClosed) return;
        socket.send(JSON.stringify(frame));
      };
      const shut = () => {
        if (socketClosed) return;
        socketClosed = true;
        try { socket.close(); }
        catch (error: unknown) { console.warn("[voice-live] socket close failed", error instanceof Error ? error.name : "UnknownError"); }
      };
      const ready = (async () => {
        const owner = principal.userId;
        if (!calls.has(owner) && calls.size + pendingStarts >= maxSessions) {
          write({ type: "error", code: "session_limit_reached", retryable: true });
          shut();
          return;
        }
        pendingStarts++;
        try {
          await calls.get(owner)?.session.close("replaced");
          const target = await options.resolveChat(principal, query.chatId);
          if (socketClosed) return;
          const started = await createVoiceLiveSession({
            adapter: options.adapter, port: options.createPort(principal, target),
            chatId: target.chatId, principalId: owner, limits: options.limits,
            send: write,
            onClosed: () => {
              if (calls.get(owner)?.session === started) calls.delete(owner);
              shut();
            },
          });
          session = started;
          if (socketClosed) { await started.close("socket_closed"); return; }
          calls.set(owner, { session: started, socket });
        } catch (error: unknown) {
          console.warn("[voice-live] call unavailable", error instanceof Error ? error.name : "UnknownError");
          if (!session) { write({ type: "error", code: safeCode(error), retryable: safeCode(error) !== "chat_unavailable" }); shut(); }
        } finally {
          pendingStarts--;
        }
      })();
      return {
        ready,
        async message(raw: string) { await session?.handle(raw); },
        async closed() {
          socketClosed = true;
          await ready;
          await session?.close("socket_closed");
        },
      };
    },
    async closeAll() {
      await Promise.allSettled([...calls.values()].map(call => call.session.close("shutdown")));
      calls.clear();
    },
  };
}
