// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { webcrypto } from "node:crypto";
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const record = {
  chat: { id: "chat_agent", ownerScope: { type: "personal", ownerId: "owner_test" }, title: "Original",
    lifecycle: "active", attention: "none", revision: 1, messageCount: 0,
    currentSelection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" },
};
const options = { instanceId: "codex_fixture", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "full_access", clientRequestId: "req_agent_fixed", resources: [{ kind: "chat" as const, id: "chat_notes", label: "Notes" }] };
it("returns a rejected result and keeps the exact reference request key for retry", async () => {
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    if (url.includes("/api/chats/chat_agent?")) return Response.json({ record, messages: [], turns: [], runs: [], activities: [] });
    if (url.includes("/turns?")) { requests.push(JSON.parse(init!.body as string)); return Response.json({ error: "Unavailable" }, { status: 503 }); }
    throw new Error("UnexpectedRequest");
  }));
  const { result } = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(result.current.busy).toBe(false));
  await waitFor(() => expect(result.current.sessionId).toBe("chat_agent"));
  let accepted: unknown;
  await act(async () => { accepted = await result.current.submitMessage("Use notes", undefined, options); });
  expect(accepted).toBe(false);
  await act(async () => { accepted = await result.current.submitMessage("Use notes", undefined, options); });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ clientRequestId: "req_agent_fixed", parts: [{ type: "text", text: "Use notes" }, { type: "resource_reference", resource: options.resources[0] }] });
  expect(requests[1]).toEqual(requests[0]);
});
it("routes referenced requests to the durable queue while a Run is active", async () => {
  const running = { ...record, activeRun: { runId: "run_busy", turnId: "cturn_busy", status: "running" } };
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/api/chats?")) return Response.json({ items: [running] });
    if (url.includes("/api/chats/chat_agent?")) return Response.json({ record: running, messages: [], turns: [], runs: [], activities: [] });
    requests.push(url);
    return Response.json({ error: "Unavailable" }, { status: 503 });
  }));
  const { result } = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(result.current.providerSelection).toBeTruthy());
  await act(async () => { await result.current.submitMessage("Use notes", undefined, options); });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("/queued-turns");
});
it("reuses attachment references after an ambiguous mentioned-request failure", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const requests: unknown[] = [];
  const uploads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    if (url.includes("/api/chats/chat_agent?")) return Response.json({ record, messages: [], turns: [], runs: [], activities: [] });
    if (url.includes("/api/files/blob?")) {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      uploads.push(path!);
      return Response.json({ ok: true, path, size: 5 });
    }
    if (url.includes("/turns?")) { requests.push(JSON.parse(init!.body as string)); return Response.json({}, { status: 503 }); }
    throw new Error("UnexpectedRequest");
  }));
  const { result } = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(result.current.providerSelection).toBeTruthy());
  const files = [{ name: "notes.txt", type: "text/plain", data: "data:text/plain;base64,aGVsbG8=" }];
  await act(async () => { await result.current.submitMessage("Use notes", files, options); });
  await act(async () => { await result.current.submitMessage("Use notes", files, options); });
  expect(requests).toHaveLength(2);
  expect(uploads[1]).toBe(uploads[0]);
  expect(requests[1]).toEqual(requests[0]);
});
it("keeps a new Chat draft selected until admission succeeds and reuses its create key", async () => {
  const createKeys: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/api/chats?")) return Response.json({ items: [] });
    if (url.endsWith("/api/chats") && init?.method === "POST") {
      createKeys.push(JSON.parse(init.body as string).clientRequestId);
      return Response.json(record);
    }
    if (url.includes("/turns?")) return Response.json({ error: "Unavailable" }, { status: 503 });
    throw new Error("UnexpectedRequest");
  }));
  const { result } = renderHook(() => useCanonicalChatState());
  await act(async () => { await result.current.submitMessage("Use notes", undefined, options); });
  expect(result.current.sessionId).toBeUndefined();
  await act(async () => { await result.current.submitMessage("Use notes", undefined, options); });
  expect(result.current.sessionId).toBeUndefined();
  expect(createKeys).toEqual(["req_agent_fixed_chat", "req_agent_fixed_chat"]);
});
