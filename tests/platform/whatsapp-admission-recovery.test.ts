import { describe, expect, it, vi } from "vitest";
import { createWhatsAppAgentClient, type WhatsAppPreparedAdmission } from "../../packages/platform/src/whatsapp/agent-client.js";
import { catalog, detail, message, record, run, selection, turn } from "./whatsapp-agent-fixtures.js";

const target = { machineId: "machine_1", gatewayUrl: "https://runtime.example", token: "private-token" };
const input = { owner: "user_1", sender: "46701234567", messageId: "wamid.first", text: "Hello" };
const checkpoint = { machineId: target.machineId, chatId: "chat_whatsapp", runId: "run_current" };

function gateway() {
  let admitted: Record<string, unknown> | undefined;
  let loseResponse = true;
  let longHistory = false;
  let executionCount = 0;
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/chats") return Response.json(record());
    if (url.pathname === "/api/chat-providers") return Response.json(catalog());
    if (url.pathname.endsWith("/turns")) {
      const payload = JSON.parse(String(init?.body));
      // Match the canonical gateway hash: revision is concurrency, not request identity.
      const identity = ({ baseRevision: _revision, ...rest }: Record<string, unknown>) => rest;
      if (admitted && JSON.stringify(identity(admitted)) !== JSON.stringify(identity(payload))) {
        return Response.json({ error: "Request conflict" }, { status: 409 });
      }
      if (!admitted) { admitted = payload; executionCount++; }
      if (loseResponse) { loseResponse = false; throw new Error("Admission committed; response lost"); }
      return Response.json({ record: record(), message: message(), turn: turn(String(payload.clientRequestId)),
        run: run(), admission: "already_accepted" });
    }
    const current = detail();
    if (!longHistory) return Response.json(current);
    return Response.json({ ...current, record: { chat: { ...record(undefined, 1000).chat, messageCount: 1000,
      currentSelection: { ...selection, model: "different-model" } } },
    messages: Array.from({ length: 200 }, (_, index) => ({ ...message(`msg_recent_${index}`), seq: 801 + index,
      turnId: "cturn_unrelated" })), nextCursor: "chatcur_older" });
  });
  return { client: createWhatsAppAgentClient(async () => target, fetcher), fetcher,
    continueChat() { longHistory = true; }, allowResponse() { loseResponse = false; },
    get executionCount() { return executionCount; } };
}

describe("durable WhatsApp admission recovery", () => {
  it("recovers a lost admission beyond the newest 200 messages without model reselection or another execution", async () => {
    const api = gateway();
    let prepared: WhatsAppPreparedAdmission | undefined;
    await expect(api.client.start(input, async () => true, async (value) => {
      prepared = value; return true;
    })).rejects.toMatchObject({ code: "request_failed" });
    expect(prepared).toBeDefined();
    api.continueChat(); api.fetcher.mockClear();
    expect(await api.client.start({ ...input, preparedAdmission: prepared })).toEqual(checkpoint);
    expect(api.executionCount).toBe(1);
    expect(api.fetcher.mock.calls.some(([url]) => String(url).includes("chat-providers"))).toBe(false);
    expect(api.fetcher.mock.calls).toHaveLength(2);
    const replay = JSON.parse(String(api.fetcher.mock.calls[1]![1]?.body));
    expect(replay).toMatchObject({ baseRevision: 1000, selection, permissionMode: "supervised" });
  });

  it("continues to admit fresh messages in a long Chat without traversing old pages", async () => {
    const api = gateway(); api.continueChat(); api.allowResponse();
    const available = catalog();
    available.instances[0]!.models[0]!.id = "different-model";
    available.instances[0]!.defaultSelection = { ...selection, model: "different-model" };
    const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) =>
      String(request).includes("chat-providers") ? Response.json(available) : api.fetcher(request, init));
    const client = createWhatsAppAgentClient(async () => target, fetcher);
    expect(await client.start({ ...input, chatId: checkpoint.chatId, machineId: target.machineId })).toEqual(checkpoint);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("cursor="))).toBe(false);
    expect(api.executionCount).toBe(1);
  });

  it("keeps the deleted-generation CAS marker when a replacement admission response is lost", async () => {
    const api = gateway();
    const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      if (String(request).includes("/api/chats/chat_deleted?")) return Response.json({ error: {
        code: "chat_not_found", safeMessage: "Chat not found.", retryable: false,
      } }, { status: 404 });
      return api.fetcher(request, init);
    });
    const client = createWhatsAppAgentClient(async () => target, fetcher);
    let prepared!: WhatsAppPreparedAdmission;
    const saved = { ...input, chatId: "chat_deleted", machineId: target.machineId };
    await expect(client.start(saved, async () => true, async (value) => {
      prepared = value; return true;
    })).rejects.toMatchObject({ code: "request_failed" });
    expect(prepared).toMatchObject({ chatId: checkpoint.chatId, replacedChatId: "chat_deleted" });
    expect(await client.start({ ...saved, preparedAdmission: prepared }))
      .toEqual({ ...checkpoint, replacedChatId: "chat_deleted" });
    expect(api.executionCount).toBe(1);
  });

  it("does not submit when the durable prepared-admission hook rejects or has an unknown outcome", async () => {
    for (const failure of [false, new Error("Checkpoint outcome unknown")]) {
      const api = gateway();
      const persist = vi.fn(async () => { if (failure instanceof Error) throw failure; return false; });
      await expect(api.client.start(input, async () => true, persist)).rejects.toThrow();
      expect(persist).toHaveBeenCalledOnce();
      expect(api.executionCount).toBe(0);
      expect(api.fetcher.mock.calls.some(([url]) => String(url).endsWith("/turns"))).toBe(false);
    }
  });

  it.each(["runtime", "missing Chat", "wrong request", "wrong text", "no consent"])("fails closed for a prepared request with %s", async (failure) => {
    const api = gateway();
    let prepared!: WhatsAppPreparedAdmission;
    await expect(api.client.start(input, async () => true, async (value) => {
      prepared = value; return true;
    })).rejects.toMatchObject({ code: "request_failed" });
    expect(prepared).toBeDefined();
    if (failure === "runtime") prepared.machineId = "other_machine";
    if (failure === "wrong request") prepared.request.clientRequestId = "req_unrelated";
    if (failure === "wrong text") prepared.request.parts = [{ type: "text", text: "Another task" }];
    if (failure === "no consent") prepared.request.permissionMode = "full_access";
    const fetcher = vi.fn(async () => Response.json({ error: {
      code: "chat_not_found", safeMessage: "Chat not found.", retryable: false,
    } }, { status: 404 }));
    const client = createWhatsAppAgentClient(async () => target, fetcher);
    await expect(client.start({ ...input, preparedAdmission: prepared })).rejects.toThrow();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/chats") || String(url).endsWith("/turns"))).toBe(false);
  });
});
