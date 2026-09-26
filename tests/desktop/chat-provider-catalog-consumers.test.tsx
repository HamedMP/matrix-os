// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadSnapshot, RuntimeSummary } from "@matrix-os/contracts";
import { ProjectChatDraft } from "@desktop/renderer/src/features/project/ProjectChatDraft";
import { AgentConversationView } from "@desktop/renderer/src/features/coding-agents/AgentConversationView";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useDraftChat } from "@desktop/renderer/src/stores/draft-chat";
import { providerCatalog, createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

const summary: RuntimeSummary = {
  runtime: { id: "rt_primary", label: "Matrix", status: "available" },
  capabilities: [{ id: "codingAgentsThreadCreate", enabled: true }],
  providers: [{ id: "codex", kind: "codex", displayName: "Codex", availability: "available",
    installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", setupActions: [] }],
  projects: { items: [], hasMore: false, limit: 20 }, activeThreads: { items: [], hasMore: false, limit: 20 },
  attentionThreads: { items: [], hasMore: false, limit: 20 }, terminalSessions: { items: [], hasMore: false, limit: 20 },
  previewSessions: { items: [], hasMore: false, limit: 20 }, recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 },
  serverTime: "2026-09-26T00:00:00.000Z",
};
const disabledCatalog = { ...providerCatalog, revision: "saved_off", instances: providerCatalog.instances.map(instance => ({
  ...instance, availability: "unavailable" as const, unavailabilityReason: "disabled_in_settings" as const,
  models: [], defaultSelection: undefined,
})) };
const thread = { thread: { id: "thread_alpha", providerId: "codex", title: "Existing chat", status: "completed",
  attention: "none", createdAt: summary.serverTime, updatedAt: summary.serverTime },
  events: { items: [], hasMore: false, limit: 200 } } as AgentThreadSnapshot;
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
function draft(runtimeSummary = summary) {
  return <ProjectChatDraft summary={runtimeSummary} projectId="matrix-os" projectLabel="Matrix OS" active
    seed={null} focusRequestId={0} typeToStartEnabled={false} onCreated={() => undefined}
    canonicalClient={client} />;
}
const client = createCanonicalChatWorkspaceClient();
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;
  resetProviderPreferences({ hydrated: true });
  useDraftChat.setState({ entries: {} });
  useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true);
  Object.defineProperty(window, "operator", { configurable: true, value: {
    invoke: vi.fn(async (channel: string) => channel === "state:get" ? { value: null } : { ok: true }),
    on: vi.fn(() => () => undefined),
  } });
});
afterEach(() => { cleanup(); useConnection.setState(useConnection.getInitialState(), true); vi.restoreAllMocks(); });
describe("native catalog consumer wiring", () => {
  it("keeps actual Project draft actions blocked after a failed read while a changed summary revalidates", async () => {
    const pending = deferred<typeof providerCatalog>();
    const get = vi.fn().mockResolvedValueOnce(providerCatalog).mockRejectedValueOnce(new Error("read_failed")).mockReturnValue(pending.promise);
    useConnection.setState({ api: { get } as never });
    const view = render(draft());
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose model and provider" }).getAttribute("data-model")).toBe("gpt-5.6-sol"));
    await setSharedComposerText(screen.getByRole("textbox", { name: "Message new chat" }), "Keep this draft");
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true));
    view.rerender(draft({ ...summary, serverTime: "2026-09-26T00:01:00.000Z" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve(providerCatalog));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
  });
  it.each(["project", "conversation"])("refreshes the actual %s picker on reopen without restarting", async surface => {
    const get = vi.fn().mockResolvedValueOnce(providerCatalog).mockResolvedValueOnce(providerCatalog).mockResolvedValue(disabledCatalog);
    useConnection.setState({ api: { get } as never });
    render(surface === "project" ? draft() : <AgentConversationView status="ready" snapshot={thread} error={null} canSendTurns summary={summary} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose model and provider" }).getAttribute("data-model")).toBe("gpt-5.6-sol"));
    openPicker();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    openPicker();
    expect(get).toHaveBeenCalledTimes(2);
    openPicker();
    await screen.findByText("Disabled in Settings");
    expect(get).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("button", { name: /GPT-5.6-Sol/ })).toBeNull();
    expect(screen.queryByText("Connect Codex")).toBeNull();
  });
});
