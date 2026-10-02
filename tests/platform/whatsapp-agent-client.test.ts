import { describe, expect, it, vi } from "vitest";
import { createWhatsAppAgentClient } from "../../packages/platform/src/whatsapp/agent-client.js";

import { selection, supports, catalog, record, run, message, turn, detail } from "./whatsapp-agent-fixtures.js";

const target = { machineId: "machine_1", gatewayUrl: "https://runtime.example", token: "private-token" };
const input = { owner: "user_1", sender: "46701234567", messageId: "wamid.first", text: "Hello" };
const checkpoint = { machineId: target.machineId, chatId: "chat_whatsapp", runId: "run_current" };

function fixture(options: { catalog?: unknown; owner?: string; status?: string; detail?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), init: init!, body });
    if (String(url).includes("chat-providers")) return Response.json(options.catalog ?? catalog());
    if (String(url).endsWith("/api/chats")) return Response.json(record(options.owner));
    if (String(url).endsWith("/turns")) return Response.json({ record: record(), message: message(),
      turn: turn(String(body.clientRequestId)), run: run(), admission: "accepted" });
    return Response.json(options.detail ?? detail(options.status));
  });
  const resolve = vi.fn(async () => target);
  return { client: createWhatsAppAgentClient(resolve, fetcher as typeof fetch), fetcher, resolve, calls };
}

describe("WhatsApp general Matrix agent client", () => {
  it.each(["fetch", "stream"])("preserves a private %s failure cause behind the generic client error", async (failure) => {
    const diagnostic = new Error("private-token at /private/runtime connection failure");
    const fetcher = vi.fn(async () => {
      if (failure === "fetch") throw diagnostic;
      return new Response(new ReadableStream({ start(controller) { controller.error(diagnostic); } }));
    });
    const client = createWhatsAppAgentClient(async () => target, fetcher);
    await expect(client.start(input)).rejects.toMatchObject({
      code: "request_failed", message: "Matrix is temporarily unavailable.", cause: diagnostic,
    });
  });
  it("retains native parsing diagnostics behind the generic client errors", async () => {
    const malformed = createWhatsAppAgentClient(async () => target, vi.fn(async () => new Response("malformed JSON")));
    await expect(malformed.start(input)).rejects.toMatchObject({ code: "invalid_response", cause: expect.any(SyntaxError) });
    const invalidTarget = createWhatsAppAgentClient(async () => ({ ...target, gatewayUrl: "invalid-url" }));
    await expect(invalidTarget.start(input)).rejects.toMatchObject({ code: "unavailable", cause: expect.any(TypeError) });
  });
  it("routes opaque Meta business-scoped user IDs without requiring a phone number", async () => {
    const { client, calls } = fixture();
    expect(await client.start({ ...input, sender: "SE.opaqueUser123" })).toEqual(checkpoint);
    const opaqueId = calls.find((call) => call.url.endsWith("/turns"))!.body!.clientRequestId;
    await client.start(input);
    expect(calls.filter((call) => call.url.endsWith("/turns"))[1].body!.clientRequestId).not.toBe(opaqueId);
  });

  it("creates one owner Chat and admits a stable request with fresh revision and supervised mode", async () => {
    const { client, calls } = fixture();
    expect(await client.start(input)).toEqual(checkpoint);
    const create = calls.find((call) => call.url.endsWith("/api/chats"))!;
    const admitted = calls.find((call) => call.url.endsWith("/turns"))!;
    expect(create.body).toMatchObject({ title: "Matrix · WhatsApp" });
    expect(create.body!.clientRequestId).toMatch(/^req_[a-f0-9]{64}$/);
    expect(admitted.body).toMatchObject({ baseRevision: 7, selection, permissionMode: "supervised",
      interactionMode: "default", parts: [{ type: "text", text: "Hello" }] });
    for (const call of calls) {
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer private-token");
    }
    await client.start(input);
    expect(calls.filter((call) => call.url.endsWith("/api/chats")).map((call) => call.body!.clientRequestId))
      .toEqual([create.body!.clientRequestId, create.body!.clientRequestId]);
    expect(calls.filter((call) => call.url.endsWith("/turns")).map((call) => call.body!.clientRequestId))
      .toEqual([admitted.body!.clientRequestId, admitted.body!.clientRequestId]);
  });

  it("accepts the Matrix-owned Pi system agent when the runtime advertises it as ready", async () => {
    const { client, calls } = fixture({ catalog: catalog("matrix_pi", "system_agent") });
    expect(await client.start(input)).toEqual(checkpoint);
    expect(calls.find((call) => call.url.endsWith("/turns"))!.body!.selection).toEqual(selection);
  });

  it("recreates only a canonically missing saved Chat with stable generation-specific creation", async () => {
    const base = fixture();
    const createIds: unknown[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/chats/chat_deleted?")) return Response.json({ error: {
        code: "chat_not_found", safeMessage: "Chat not found.", retryable: false,
      } }, { status: 404 });
      if (String(url).endsWith("/api/chats")) createIds.push(JSON.parse(String(init?.body)).clientRequestId);
      return base.fetcher(url, init);
    });
    const client = createWhatsAppAgentClient(async () => target, fetcher as typeof fetch);
    const saved = { ...input, chatId: "chat_deleted", machineId: target.machineId };
    expect(await client.start(saved)).toEqual({ ...checkpoint, replacedChatId: "chat_deleted" });
    expect(await client.start(saved)).toEqual({ ...checkpoint, replacedChatId: "chat_deleted" });
    expect(createIds[0]).toEqual(createIds[1]);
    await client.start(input);
    expect(createIds[2]).not.toEqual(createIds[0]);
  });

  it("rejects a replacement response that returns the deleted Chat again", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("chat_deleted?")) return Response.json({ error: { code: "chat_not_found", safeMessage: "Chat not found.", retryable: false } }, { status: 404 });
      return Response.json({ ...record(), chat: { ...record().chat, id: "chat_deleted" } });
    });
    const client = createWhatsAppAgentClient(async () => target, fetcher);
    await expect(client.start({ ...input, chatId: "chat_deleted", machineId: target.machineId })).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([403, 503, 404])("never recreates a Chat for unrecognized gateway error %s", async (status) => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: "route_not_found", safeMessage: "Unavailable", retryable: false } }, { status }));
    const client = createWhatsAppAgentClient(async () => target, fetcher);
    await expect(client.start({ ...input, chatId: "chat_deleted", machineId: target.machineId })).rejects.toMatchObject({ code: "request_failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rechecks consent before replacing a deleted Chat", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: "chat_not_found", safeMessage: "Chat not found.", retryable: false } }, { status: 404 }));
    const client = createWhatsAppAgentClient(async () => target, fetcher);
    await expect(client.start({ ...input, chatId: "chat_deleted", machineId: target.machineId }, async () => false)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects coding Pi even if ready and selected", async () => {
    const { client, calls } = fixture({ catalog: catalog("pi", "coding_agent") });
    await expect(client.start(input)).rejects.toMatchObject({ code: "unavailable" });
    expect(calls.some((call) => call.url.endsWith("/turns"))).toBe(false);
  });

  it("uses full access only with explicit persisted owner consent", async () => {
    const { client, calls } = fixture({ catalog: catalog("kernel", "system_agent", ["full_access"]) });
    await expect(client.start(input)).rejects.toMatchObject({ code: "unavailable" });
    await client.start({ ...input, allowFullAccess: true });
    expect(calls.find((call) => call.url.endsWith("/turns"))!.body!.permissionMode).toBe("full_access");
  });

  it("does not change runtime or owner and never posts a turn for them", async () => {
    const { client, calls } = fixture();
    await expect(client.start({ ...input, chatId: "chat_whatsapp", machineId: "other_machine" }))
      .rejects.toMatchObject({ code: "runtime_changed" });
    await expect(fixture({ owner: "other_owner" }).client.start(input))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(calls).toHaveLength(0);
    await expect(client.poll(input.owner, { ...checkpoint, machineId: "other_machine" }))
      .rejects.toMatchObject({ code: "runtime_changed" });
  });

  it("recovers an already admitted turn before catalog changes can alter its request", async () => {
    const initial = fixture();
    await initial.client.start(input);
    const requestId = String(initial.calls.find((call) => call.url.endsWith("/turns"))!.body!.clientRequestId);
    const duplicateDetail = { ...detail("completed"), turns: [turn(requestId)] };
    const { client, calls } = fixture({ detail: duplicateDetail, catalog: { revision: "bad" } });
    expect(await client.start({ ...input, chatId: "chat_whatsapp", machineId: target.machineId })).toEqual(checkpoint);
    expect(calls.some((call) => call.url.includes("chat-providers") || call.url.endsWith("/turns"))).toBe(false);
  });

  it("returns only committed assistant text for the checkpoint run", async () => {
    const response = detail("completed");
    response.messages.push(message("msg_old", "assistant", "Old response", "run_old"));
    expect(await fixture({ detail: response }).client.poll(input.owner, checkpoint))
      .toEqual({ state: "complete", text: "Your answer" });
  });

  it("collects the checkpoint response across cursor pages without unrelated history", async () => {
    const first = { ...detail("completed"), messages: [
      { ...message("msg_second", "assistant", "Second paragraph", "run_current"), seq: 201 },
    ], nextCursor: "chatcur_page1" };
    const older = { ...detail("completed"), messages: [message(),
      message("msg_first", "assistant", "First paragraph", "run_current")], runs: [] };
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      Response.json(String(url).includes("cursor=") ? older : first));
    const client = createWhatsAppAgentClient(async () => target, fetcher as typeof fetch);
    expect(await client.poll(input.owner, checkpoint))
      .toEqual({ state: "complete", text: "First paragraph\n\nSecond paragraph" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never forwards transcript data from another owner or incomplete pagination", async () => {
    await expect(fixture({ detail: { ...detail("completed"), record: record("other_owner") } })
      .client.poll(input.owner, checkpoint)).rejects.toMatchObject({ code: "invalid_response" });
    const fetcher = vi.fn(async () => Response.json({ ...detail("completed"), messages: [
      { ...message("msg_far", "assistant", "Incomplete", "run_current"), seq: 800 },
    ], nextCursor: "chatcur_page1" }));
    const client = createWhatsAppAgentClient(async () => target, fetcher as typeof fetch);
    expect(await client.poll(input.owner, checkpoint)).toEqual({ state: "attention" });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("bounds a long assistant reply while preserving valid Unicode", async () => {
    const response = detail("completed");
    response.messages[1] = message("msg_reply", "assistant", "😀".repeat(2200), "run_current");
    const result = await fixture({ detail: response }).client.poll(input.owner, checkpoint);
    expect(result.state).toBe("complete");
    if (result.state !== "complete") throw new Error("Expected complete fixture");
    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(result.text).toContain("Open Matrix");
    expect(result.text.isWellFormed()).toBe(true);
  });

  it.each(["waiting_for_approval", "waiting_for_input", "failed", "aborted"])("projects %s safely to attention", async (status) => {
    expect(await fixture({ status }).client.poll(input.owner, checkpoint)).toEqual({ state: "attention" });
  });

  it("keeps incomplete runs pending and an empty completed result requires Matrix", async () => {
    expect(await fixture({ status: "running" }).client.poll(input.owner, checkpoint)).toEqual({ state: "pending" });
    expect(await fixture({ detail: { ...detail("completed"), messages: [message()] } }).client.poll(input.owner, checkpoint))
      .toEqual({ state: "attention" });
  });

  it("fails closed for malformed contracts and bounded response bodies", async () => {
    await expect(fixture({ catalog: { rawError: "private provider detail" } }).client.start(input))
      .rejects.toMatchObject({ code: "invalid_response", message: "Matrix is temporarily unavailable." });
    const fetcher = vi.fn(async () => new Response("x".repeat(2_100_000)));
    const client = createWhatsAppAgentClient(async () => target, fetcher as typeof fetch);
    await expect(client.start(input)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("normalizes network failures and runtime configuration without leaking tokens", async () => {
    const fetcher = vi.fn(async () => { throw new Error("private-token at /private/provider"); });
    const client = createWhatsAppAgentClient(async () => target, fetcher as typeof fetch);
    await expect(client.start(input)).rejects.toMatchObject({ code: "request_failed", message: "Matrix is temporarily unavailable." });
    const invalid = createWhatsAppAgentClient(async () => ({ ...target, gatewayUrl: "https://runtime.example/?token=private" }));
    await expect(invalid.start(input)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("keeps the original resolver failure available only as a server diagnostic", async () => {
    const diagnostic = new Error("private database resolver failure");
    const fetcher = vi.fn();
    const client = createWhatsAppAgentClient(async () => { throw diagnostic; }, fetcher);
    await expect(client.start(input)).rejects.toMatchObject({
      code: "unavailable", message: "Matrix is temporarily unavailable.", cause: diagnostic,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...target, machineId: "../private" }, { ...target, token: "" },
    { ...target, token: "unsafe\r\ntoken" }, { ...target, token: "x".repeat(8193) },
    { ...target, gatewayUrl: "not a URL" }, { ...target, gatewayUrl: "file:///private" },
    { ...target, gatewayUrl: "https://user:password@runtime.example/" },
    { ...target, gatewayUrl: "https://runtime.example/private" },
  ])("fails closed before sending credentials for an invalid configured target %#", async (configured) => {
    const fetcher = vi.fn();
    const client = createWhatsAppAgentClient(async () => configured, fetcher);
    await expect(client.start(input)).rejects.toMatchObject({ code: "unavailable", message: "Matrix is temporarily unavailable." });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    () => new Response(null), () => new Response("private body", { status: 503 }),
    () => new Response("{}", { headers: { "content-length": "2100000" } }),
    () => new Response("malformed JSON"),
  ])("rejects missing, unsuccessful, excessive advertised, or malformed runtime bodies %#", async (response) => {
    const client = createWhatsAppAgentClient(async () => target, vi.fn(async () => response()));
    await expect(client.start(input)).rejects.toMatchObject({ message: "Matrix is temporarily unavailable." });
  });
  it("logs stream cleanup failures while preserving a safe runtime error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const stream = new ReadableStream({ cancel() { throw new Error("private cleanup path"); } });
      const client = createWhatsAppAgentClient(async () => target, vi.fn(async () => new Response(stream, { status: 503 })));
      await expect(client.start(input)).rejects.toMatchObject({ code: "request_failed" });
      expect(warn).toHaveBeenCalledWith("[whatsapp/agent] Response cleanup failed", "Error");
    } finally { warn.mockRestore(); }
  });
  it("rejects admission after revocation before Chat creation or turn submission", async () => {
    const first = fixture();
    await expect(first.client.start(input, async () => false)).rejects.toMatchObject({ code: "unavailable" });
    expect(first.calls).toHaveLength(0);
    const saved = fixture();
    await expect(saved.client.start({ ...input, chatId: checkpoint.chatId, machineId: target.machineId }, async () => false))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(saved.calls.some((call) => call.url.endsWith("/turns"))).toBe(false);
  });
  it("uses a ready default selection for a Chat without a saved model", async () => {
    const response = detail();
    const { currentSelection: _saved, ...chat } = response.record.chat;
    const { client, calls } = fixture({ detail: { ...response, record: { chat } } });
    await client.start(input);
    expect(calls.find((call) => call.url.endsWith("/turns"))?.body?.selection).toEqual(selection);
  });
  it("does not replay an existing turn whose first run is absent", async () => {
    const initial = fixture();
    await initial.client.start(input);
    const requestId = String(initial.calls.find((call) => call.url.endsWith("/turns"))!.body!.clientRequestId);
    const existing = fixture({ detail: { ...detail(), turns: [turn(requestId)], runs: [] } });
    await expect(existing.client.start({ ...input, chatId: checkpoint.chatId, machineId: target.machineId }))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(existing.calls.some((call) => call.url.endsWith("/turns"))).toBe(false);
  });
  it("requires attention when the checkpoint run is missing from complete history", async () => {
    expect(await fixture({ detail: detail() }).client.poll(input.owner, checkpoint)).toEqual({ state: "attention" });
  });
  it("rejects a runtime admission for a different idempotency request", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("chat-providers")) return Response.json(catalog());
      if (String(url).endsWith("/turns")) return Response.json({ record: record(), message: message(),
        turn: turn("req_other_request"), run: run(), admission: "accepted" });
      return Response.json(detail());
    });
    const client = createWhatsAppAgentClient(async () => target, fetcher as typeof fetch);
    await expect(client.start({ ...input, chatId: checkpoint.chatId, machineId: target.machineId }))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});
