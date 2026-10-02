// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentThreadSnapshot, CanonicalProviderCatalog, RuntimeSummary } from "@matrix-os/contracts";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { ProjectChatDraft } from "../../desktop/src/renderer/src/features/project/ProjectChatDraft";
import { AgentConversationView } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationView";
import { HermesPane } from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { createLegacyProjectProviderCatalog } from "../../desktop/src/renderer/src/features/chat/canonical-composer-adapter";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { clearDraftChats } from "../../desktop/src/renderer/src/stores/draft-chat";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { resetProviderPreferences } from "./provider-preferences-test-utils";

vi.mock("../../desktop/src/renderer/src/features/chat/ChatProviderOnboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const summary: RuntimeSummary = {
  runtime: { id: "rt_fixture", label: "Primary", status: "available" },
  capabilities: [{ id: "codingAgentsThreadCreate", enabled: true }],
  providers: [{ id: "codex", kind: "codex", displayName: "Codex", availability: "available", installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", setupActions: [] }],
  projects: { items: [], hasMore: false, limit: 20 },
  activeThreads: { items: [], hasMore: false, limit: 20 },
  attentionThreads: { items: [], hasMore: false, limit: 20 },
  terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
  previewSessions: { items: [], hasMore: false, limit: 50 },
  recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
  serverTime: "2026-10-02T12:00:00.000Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.operator = { invoke: vi.fn(async () => ({ value: null })), on: vi.fn(() => () => undefined) };
  useConnection.setState(useConnection.getInitialState(), true);
  useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true);
  resetProviderPreferences({ hydrated: true });
  clearDraftChats();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useConnection.setState(useConnection.getInitialState(), true); useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true); clearDraftChats(); });

it.each(["project draft", "canonical project draft", "existing agent conversation"] as const)("shows initial and forced loading directly on the closed %s trigger and prevents sending", async (surface) => {
  const catalog = createLegacyProjectProviderCatalog(summary);
  const initial = deferred<CanonicalProviderCatalog>();
  const refreshed = deferred<CanonicalProviderCatalog>();
  const get = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
  const send = vi.fn();
  const create = vi.fn();
  useConnection.setState({ status: "signed-in", api: { get } as unknown as ApiClient });
  useCodingAgentWorkspace.setState({ summary, status: "ready", sendThreadMessage: send, createThread: create });
  if (surface !== "existing agent conversation") {
    render(<ProjectChatDraft summary={summary} projectId="project_fixture" projectLabel="Fixture" active seed={null} focusRequestId={0} typeToStartEnabled={false} onCreated={vi.fn()} canonicalClient={surface === "canonical project draft" ? createCanonicalChatWorkspaceClient() : undefined} />);
  } else {
    const snapshot: AgentThreadSnapshot = { thread: { id: "thread_fixture", providerId: "codex", title: "Fixture", status: "completed", attention: "none", createdAt: summary.serverTime, updatedAt: summary.serverTime }, events: { items: [], hasMore: false, limit: 200 } };
    render(<AgentConversationView status="ready" snapshot={snapshot} error={null} canSendTurns summary={summary} />);
  }
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await act(async () => initial.resolve(catalog));
  await waitFor(() => expect(within(trigger).queryByRole("status")).toBeNull());
  const model = trigger.getAttribute("data-model");
  expect(model).toBeTruthy();
  await setSharedComposerText(screen.getByRole("textbox", { name: surface === "existing agent conversation" ? "Message conversation" : "Message new chat" }), "Keep this draft");
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  fireEvent.click(trigger);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  expect(trigger).toHaveAttribute("data-model", model);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  await act(async () => refreshed.resolve(catalog));
  await waitFor(() => expect(within(trigger).queryByRole("status")).toBeNull());
});

it("shows bootstrap loading on the closed global Chat trigger before the API is initialized", () => {
  render(<HermesPane />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  act(() => useConnection.setState({ status: "signed-out", api: null }));
  expect(within(trigger).queryByRole("status", { name: "Checking model availability" })).toBeNull();
});

it.each(["signed-out", "signed-in"] as const)("does not claim ongoing bootstrap loading for a settled %s connection without an API", (status) => {
  useConnection.setState({ status, api: null });
  render(<HermesPane />);
  expect(within(screen.getByRole("button", { name: "Choose model and provider" })).queryByRole("status", { name: "Checking model availability" })).toBeNull();
});

it("does not animate an inactive global Chat route during connection bootstrap", () => {
  render(<HermesPane active={false} />);
  expect(within(screen.getByRole("button", { name: "Choose model and provider" })).queryByRole("status", { name: "Checking model availability" })).toBeNull();
});
