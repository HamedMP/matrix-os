// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/ChatApp";
import { useCanonicalChatState } from "@/hooks/useCanonicalChatState";
import { CanonicalChatListResponseSchema, CanonicalChatDetailResponseSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
vi.mock("@clerk/nextjs", async original => ({
  ...(await original<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

it.each([false, true])("cancels the exact running Pi request while reserved credit blocks new sends (mobile=%s)", async mobile => {
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const snapshot = createCanonicalChatFixture("running").snapshot;
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  snapshot.chat.currentSelection = selection;
  snapshot.chat.providerBinding = { ...snapshot.chat.providerBinding!, driverKind: "matrix_pi", instanceId: selection.instanceId };
  const chatId = snapshot.chat.id;
  const runId = snapshot.chat.activeRun!.runId;
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.drivers = [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }];
  const base = catalog.instances[0]!;
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    availability: "unavailable", connectionState: "credit_reserved", defaultSelection: undefined,
    models: [{ ...base.models[0]!, id: selection.model, displayName: "Claude Sonnet 5", availability: "unavailable" }] }];
  let active = true;
  function detail() {
    const { activeRun, providerBinding, project, ...chat } = snapshot.chat;
    return { record: { chat, providerBinding, projectId: project?.projectId, ...(active ? { activeRun } : {}) },
      messages: snapshot.messages, turns: [], runs: [], activities: [] };
  }
  const cancel = vi.fn(async () => {
    active = false;
    return Response.json({ run: { ...snapshot.runs[0]!, driverKind: "matrix_pi", instanceId: selection.instanceId, selection,
      status: "aborted", outcome: "aborted", completedAt: "2026-10-02T08:00:00.000Z" }, cancellation: "aborted" });
  });
  CanonicalChatListResponseSchema.parse({ items: [detail().record] });
  CanonicalChatDetailResponseSchema.parse(detail());
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/chat-providers")) return Response.json(catalog);
    if (url.includes("/api/chats/events?")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    if (url.includes("/api/chats?")) return Response.json({ items: [detail().record] });
    if (url.includes(`/api/chats/${chatId}/runs/${runId}/cancel`)) { expect(init?.method).toBe("POST"); return cancel(); }
    if (url.includes(`/api/chats/${chatId}?`)) return Response.json(detail());
    throw new Error("Unexpected request in held-credit cancellation fixture");
  });
  vi.stubGlobal("fetch", fetcher);
  function Harness() {
    const state = useCanonicalChatState();
    return <ChatApp messages={state.messages} sessionId={state.sessionId} busy={state.busy} activeRunId={state.activeRunId}
      onAbortCurrent={state.abortCurrent} connected={state.connected} conversations={state.conversations}
      onNewChat={state.newChat} onSwitchConversation={state.switchConversation} onSubmit={state.submitMessage}
      providerSelection={state.providerSelection} boundProviderInstanceId={state.boundProviderInstanceId} mobile={mobile} />;
  }
  render(<Harness />);
  await screen.findByText("Credit reserved");
  const editor = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(editor, { target: { value: "Preserve this draft" } });
  const stop = await screen.findByRole("button", { name: "Stop", exact: true });
  expect((stop as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(stop);
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop", exact: true })).toBeNull());
  expect((screen.getByRole("button", { name: "Send", exact: true }) as HTMLButtonElement).disabled).toBe(true);
  expect((editor as HTMLTextAreaElement).value).toBe("Preserve this draft");
  expect(screen.getByText("Credit reserved")).toBeTruthy();
  expect(fetcher.mock.calls.some(([url, init]) => url.endsWith("/turns") && init?.method === "POST")).toBe(false);
});
