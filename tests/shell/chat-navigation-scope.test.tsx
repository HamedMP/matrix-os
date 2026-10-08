// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import { clearChatNavigationScopes } from "@matrix-os/ui";
import { useShellChatNavigation } from "../../shell/src/hooks/useChatNavigation";
import type { CanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client";

const events = { subscribe: () => ({ dispose() {} }) } as Parameters<typeof useShellChatNavigation>[1];
const snapshot: CanonicalChatNavigationResponse = {
  version: 1, truncated: false, items: [{
    chat: { id: "chat_scope", title: "Scoped", revision: 1, lifecycle: "active", attention: "none", messageCount: 0, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" },
    readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 },
    classification: { kind: "ordinary" }, persistence: "personal",
  }],
};
afterEach(() => { cleanup(); clearChatNavigationScopes(); });
it("does not retain another client's memory snapshot when no verified Web scope exists", async () => {
  const first = { navigation: vi.fn(async () => snapshot) } as unknown as CanonicalShellChatClient;
  const second = { navigation: vi.fn(() => new Promise<CanonicalChatNavigationResponse>(() => {})) } as unknown as CanonicalShellChatClient;
  const hook = renderHook(({ client }) => useShellChatNavigation(client, events), { initialProps: { client: first } });
  await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  hook.rerender({ client: second });
  expect(hook.result.current.items).toEqual([]);
  expect(second.navigation).toHaveBeenCalledTimes(1);
});

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

it("clears selected detail when the verified viewer changes while the next snapshot is pending", async () => {
  const { snapshot: fixture } = createCanonicalChatFixture("completed");
  const { project, activeRun, providerBinding, ...chat } = fixture.chat;
  const fullDetail = { record: { chat, projectId: project?.projectId, activeRun, providerBinding }, messages: fixture.messages, turns: fixture.turns, runs: fixture.runs };
  const initialNavigation: CanonicalChatNavigationResponse = { ...snapshot, items: [{ ...snapshot.items[0]!, chat: { ...snapshot.items[0]!.chat, id: chat.id, title: chat.title } }] };
  let navigationCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.includes("/api/chat-navigation?")) {
      if (++navigationCalls > 1) return new Promise<Response>(() => {});
      return Response.json(initialNavigation);
    }
    if (input.includes("/events?")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    return Response.json(fullDetail);
  }));
  const hook = renderHook(({ scope }) => useCanonicalChatState({ navigationScope: scope, navigationGeneration: scope }), { initialProps: { scope: "first/runtime/main" } });
  await waitFor(() => expect(hook.result.current.sessionId).toBe(chat.id));
  await waitFor(() => expect(hook.result.current.messages.length).toBeGreaterThan(0));
  hook.rerender({ scope: "second/runtime/main" });
  expect(hook.result.current.sessionId).toBeUndefined();
  expect(hook.result.current.messages).toEqual([]);
  vi.unstubAllGlobals();
});

it.each([401, 403])("reclassifies legacy Bot bindings after same-store %s recovery and reuses the recovered cache on warm reads", async status => {
  const { act } = await import("@testing-library/react");
  const { createCanonicalShellChatClient } = await import("../../shell/src/lib/canonical-chat-client");
  let revoked = false;
  let recovered = false;
  const fetcher = vi.fn(async (input: string) => {
    if (input.includes("/api/chat-navigation?")) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (input.includes("/api/chats?")) return revoked
      ? Response.json({ error: { code: "unauthorized" } }, { status })
      : Response.json({ items: [{ chat: { ...snapshot.items[0]!.chat, ownerScope: { type: "personal", ownerId: "owner_legacy" }, currentSelection: { instanceId: "pi_default", model: "model" } } }] });
    if (input.includes("/api/chat-agents")) return Response.json({ enabled: true, agents: [] });
    if (input.includes("/bot?")) return Response.json({ agentId: recovered ? "bot_12345678" : null });
    throw new Error("Unexpected test request");
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const client = createCanonicalShellChatClient({ gatewayUrl: "https://runtime.test" });
    const hook = renderHook(() => useShellChatNavigation(client, events, "legacy/runtime/main", "same_session"));
    await waitFor(() => expect(hook.result.current.items[0]?.classification.kind).toBe("ordinary"));
    const store = hook.result.current.store!;
    const bindingReads = () => fetcher.mock.calls.filter(([url]) => url.includes("/bot?")).length;
    expect(bindingReads()).toBe(1);
    revoked = true;
    await act(async () => store.refresh());
    expect(hook.result.current.store).toBe(store);
    expect(hook.result.current.items).toEqual([]);
    expect(store.getAuthorityEpoch()).toBeGreaterThan(0);
    revoked = false;
    recovered = true;
    await act(async () => store.refresh());
    expect(hook.result.current.items[0]?.classification).toEqual({ kind: "bot", agentId: "bot_12345678" });
    expect(bindingReads()).toBe(2);
    const calls = fetcher.mock.calls.length;
    hook.rerender();
    expect(fetcher.mock.calls.length).toBe(calls);
    hook.unmount();
    const remounted = renderHook(() => useShellChatNavigation(client, events, "legacy/runtime/main", "same_session"));
    expect(remounted.result.current.store).toBe(store);
    await act(async () => store.refresh());
    expect(bindingReads()).toBe(2);
    expect(remounted.result.current.items[0]?.classification.kind).toBe("bot");
  } finally { vi.unstubAllGlobals(); }
});
