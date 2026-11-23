import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { CanonicalChatRunSchema } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createAgentThreadChatRoutes } from "../../packages/gateway/src/chat/agent-thread-chat-routes.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const owner = { type: "personal" as const, ownerId: "owner" };
const at = "2026-09-08T00:00:00.000Z";
const THREAD = "thread_0123456789abcdef";

describe("agent thread to canonical Chat lookup", () => {
  let database: Awaited<ReturnType<typeof KyselyPGlite.create>>;
  let repository: ChatRepository;
  beforeEach(async () => { database = await KyselyPGlite.create(); repository = new ChatRepository(database.dialect); await repository.bootstrap(); });
  afterEach(async () => { await repository.release(); await repository.kysely.destroy(); });

  async function chatBackedBy(threadId: string, chatId = "chat_agent", projectId?: string) {
    const created = await repository.create(owner, { id: chatId, clientRequestId: `req_${chatId}`, title: "Agent work", ...(projectId ? { projectId } : {}) });
    const message = { id: `msg_${chatId}`, chatId, seq: 1, role: "user" as const, state: "committed" as const,
      turnId: `cturn_${chatId}`, parts: [{ type: "text" as const, text: "Task" }], createdAt: at };
    const turn = { id: `cturn_${chatId}`, chatId, clientRequestId: `req_turn_${chatId}`, baseMessageSeq: 0,
      inputMessageId: message.id, status: "accepted" as const, createdAt: at, updatedAt: at };
    const run = CanonicalChatRunSchema.parse({ id: `run_${chatId}`, chatId, turnId: turn.id, attempt: 1,
      driverKind: "codex", instanceId: "codex_default", selection: { instanceId: "codex_default", model: "model" },
      interactionMode: "default", permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0,
      capabilitySnapshot: { revision: "catalog_1", rootChat: true, attachments: [], resources: [], tools: [],
        approvals: true, userInput: true, resume: true, cancellation: true, steering: "same_run", worktrees: "optional",
        interactionModes: ["default"], permissionModes: ["supervised"] }, createdAt: at, updatedAt: at });
    await repository.admitTurn(owner, { chatId, baseRevision: created.chat.revision, message, turn, run,
      adapterState: { schemaVersion: 1, state: { conversationId: threadId } } });
  }

  function app(userId = "owner", database: ChatRepository["kysely"] | null = repository.kysely) {
    const routes = new Hono();
    routes.route("/", createAgentThreadChatRoutes({ database, getPrincipal: () => ({ userId } as RequestPrincipal) }));
    return routes;
  }

  it("resolves a coding-agent thread to the canonical Chat that owns it", async () => {
    await chatBackedBy(THREAD, "chat_agent", "matrix-os");
    const response = await app().request(`/api/chats/by-agent-thread/${THREAD}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chatId: "chat_agent", projectId: "matrix-os" });
  });

  it("never resolves another owner's thread", async () => {
    await chatBackedBy(THREAD);
    const response = await app("intruder").request(`/api/chats/by-agent-thread/${THREAD}`);
    expect(response.status).toBe(404);
  });

  it("returns not found for an unknown thread and rejects malformed ids", async () => {
    expect((await app().request("/api/chats/by-agent-thread/thread_unknown000000")).status).toBe(404);
    expect((await app().request("/api/chats/by-agent-thread/not-a-thread")).status).toBe(400);
  });

  it("reports an unavailable store as a generic 503", async () => {
    const response = await app("owner", null).request(`/api/chats/by-agent-thread/${THREAD}`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/postgres|kysely/i);
  });
});
