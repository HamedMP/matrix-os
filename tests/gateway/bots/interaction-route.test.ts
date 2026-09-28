import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createBotContinuationAdmitter } from "../../../packages/gateway/src/bots/continuations.js";
import { BotInteractionError } from "../../../packages/gateway/src/bots/interactions.js";
import { BotMemoryError } from "../../../packages/gateway/src/bots/memory-service.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { CanonicalChatOrchestrationError, canonicalChatSafeError } from "../../../packages/gateway/src/chat/orchestration-errors.js";

const PRINCIPAL = { userId: "user_owner_1", source: "jwt" } as never;
const CHAT = "chat_route1";
const INTERACTION = "in_0123456789abcdef";
const RESOLVED = { interaction: { interactionId: INTERACTION, status: "resolved" as const, revision: 2 } };
const CONTINUATION = { chatId: CHAT, clientRequestId: `req_answer_${INTERACTION}`, text: "Casual" };

function app(options: Parameters<typeof createBotRoutes>[0] extends infer O ? Omit<O & object, "getPrincipal"> : never) {
  const server = new Hono();
  server.route("/", createBotRoutes({ ...options, getPrincipal: () => PRINCIPAL }));
  return server;
}

const post = (server: Hono, path: string, body: string) => server.request(path, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("bot interaction and memory routes", () => {
  it("records an answer, then continues the task as the responder", async () => {
    const resolve = vi.fn(async () => ({ response: RESOLVED, continuation: CONTINUATION }));
    const admitContinuation = vi.fn(async () => undefined);
    const server = app({ interactions: { resolve, listPending: vi.fn() }, admitContinuation });
    const response = await post(server, `/api/chats/${CHAT}/interactions/${INTERACTION}/resolve`, JSON.stringify({ kind: "question", baseRevision: 1, answer: "Casual" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(RESOLVED);
    expect(resolve).toHaveBeenCalledWith("user_owner_1", CHAT, INTERACTION, { kind: "question", baseRevision: 1, answer: "Casual" });
    expect(admitContinuation).toHaveBeenCalledWith(PRINCIPAL, CONTINUATION);
  });

  it("answers 503 when the continuation fails, so the same request can be retried", async () => {
    const server = app({
      interactions: { resolve: vi.fn(async () => ({ response: RESOLVED, continuation: CONTINUATION })), listPending: vi.fn() },
      admitContinuation: vi.fn(async () => { throw new Error("orchestrator closed"); }),
    });
    const response = await post(server, `/api/chats/${CHAT}/interactions/${INTERACTION}/resolve`, "{}");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable", message: expect.any(String) });
  });

  it("maps refusals to allowlisted codes, bounds bodies, and answers 503 without services", async () => {
    for (const [code, status] of [["invalid_request", 400], ["not_found", 404], ["conflict", 409], ["expired", 410]] as const) {
      const server = app({ interactions: { resolve: vi.fn(async () => { throw new BotInteractionError(code); }), listPending: vi.fn() }, admitContinuation: vi.fn() });
      const response = await post(server, `/api/chats/${CHAT}/interactions/${INTERACTION}/resolve`, "{}");
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code, message: expect.any(String) });
    }
    const server = app({ interactions: { resolve: vi.fn(), listPending: vi.fn() }, admitContinuation: vi.fn() });
    expect((await post(server, `/api/chats/${CHAT}/interactions/${INTERACTION}/resolve`, JSON.stringify({ answer: "x".repeat(70 * 1024) }))).status).toBe(413);
    expect((await post(server, `/api/chats/${CHAT}/interactions/${INTERACTION}/resolve`, "{nope")).status).toBe(400);
    expect((await post(app({}), `/api/chats/${CHAT}/interactions/${INTERACTION}/resolve`, "{}")).status).toBe(503);
    expect((await app({}).request(`/api/chats/${CHAT}/interactions`)).status).toBe(503);
  });

  it("lists pending questions for the principal", async () => {
    const listPending = vi.fn(async () => []);
    const response = await app({ interactions: { resolve: vi.fn(), listPending } }).request(`/api/chats/${CHAT}/interactions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interactions: [] });
    expect(listPending).toHaveBeenCalledWith("user_owner_1", CHAT);
  });

  it("forgets and confirms memory through the service, with its refusals", async () => {
    const forget = vi.fn(async () => ({ itemId: "mem_0123456789ab", revision: 3 }));
    const confirm = vi.fn(async () => { throw new BotMemoryError("conflict"); });
    const server = app({ memory: { forget, confirm } });
    const forgotten = await post(server, "/api/chat-agents/bot_0123456789abcdef/memory/mem_0123456789ab/forget", JSON.stringify({ baseRevision: 2 }));
    expect(forgotten.status).toBe(200);
    expect(forget).toHaveBeenCalledWith("user_owner_1", "bot_0123456789abcdef", "mem_0123456789ab", { baseRevision: 2 });
    expect((await post(server, "/api/chat-agents/bot_0123456789abcdef/memory/mem_0123456789ab/confirm", JSON.stringify({ baseRevision: 1 }))).status).toBe(409);
    expect((await post(app({}), "/api/chat-agents/bot_0123456789abcdef/memory/mem_0123456789ab/forget", "{}")).status).toBe(503);
  });
});

describe("answer continuations", () => {
  const record = (revision: number) => ({ chat: { revision } }) as never;

  it("admits the answer once as the owner's message on the bot runtime", async () => {
    const admitTurn = vi.fn(async () => ({}) as never);
    const admit = createBotContinuationAdmitter({ repository: { get: vi.fn(async () => record(4)) }, orchestrator: { admitTurn, enqueueQueuedTurn: vi.fn() } });
    await admit(PRINCIPAL, CONTINUATION);
    expect(admitTurn).toHaveBeenCalledWith(PRINCIPAL, { type: "personal", ownerId: "user_owner_1" }, CHAT, {
      clientRequestId: CONTINUATION.clientRequestId, baseRevision: 4, parts: [{ type: "text", text: "Casual" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    });
  });

  it("queues behind a busy chat and retries once after a concurrent change", async () => {
    const busy = new CanonicalChatOrchestrationError(canonicalChatSafeError("chat_busy", "Busy"), 409);
    const changed = new CanonicalChatOrchestrationError(canonicalChatSafeError("chat_conflict", "Changed"), 409);
    const enqueueQueuedTurn = vi.fn(async () => ({}) as never);
    await createBotContinuationAdmitter({
      repository: { get: vi.fn(async () => record(1)) },
      orchestrator: { admitTurn: vi.fn(async () => { throw busy; }), enqueueQueuedTurn },
    })(PRINCIPAL, CONTINUATION);
    expect(enqueueQueuedTurn).toHaveBeenCalledTimes(1);

    const admitTurn = vi.fn().mockRejectedValueOnce(changed).mockResolvedValueOnce({});
    const get = vi.fn().mockResolvedValueOnce(record(1)).mockResolvedValueOnce(record(2));
    await createBotContinuationAdmitter({ repository: { get }, orchestrator: { admitTurn, enqueueQueuedTurn: vi.fn() } })(PRINCIPAL, CONTINUATION);
    expect(admitTurn.mock.calls.map((call) => (call[3] as { baseRevision: number }).baseRevision)).toEqual([1, 2]);

    await expect(createBotContinuationAdmitter({
      repository: { get: vi.fn(async () => null) }, orchestrator: { admitTurn: vi.fn(), enqueueQueuedTurn: vi.fn() },
    })(PRINCIPAL, CONTINUATION)).rejects.toEqual(new BotInteractionError("not_found"));
  });
});
