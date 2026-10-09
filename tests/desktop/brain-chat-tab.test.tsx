// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainChatHost, BrainChatSlot, ChatAgentClient } from "@matrix-os/ui";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { stopDesktopProviderCatalogCoordinator } from "@desktop/renderer/src/features/chat/provider-catalog-coordinator";
import { useDesktopBrainChatHost } from "@desktop/renderer/src/features/brain/DesktopBrainChat";
import { WorkSurfaceRuntimeProvider } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

/** The chat client the tab's runtime makes; a test can hand it its own. */
const runtime = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@desktop/renderer/src/lib/canonical-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@desktop/renderer/src/lib/canonical-chat-client")>();
  return { ...actual, createCanonicalChatClient: (api: ApiClient) => (runtime.client ?? actual.createCanonicalChatClient(api)) as CanonicalChatClient };
});

const BOT = {
  id: "bot_brain0001", name: "Company Brain", revision: 1, instructions: "Short answers.", description: "Brain",
  archived: false, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
  selection: { instanceId: "matrix_bot_default", model: "auto" }, recipeRef: { recipeId: "company-brain", version: "1" },
};
const PROMPT_DETAIL = "Answers come only from this project's brain, with a link to every source.";
const created = { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, revision: 0, messageCount: 0 }, projectId: undefined, providerBinding: undefined };

function fakeApi(): ApiClient {
  const api = {
    baseUrl: "https://matrix.test", get: vi.fn(async () => ({ enabled: true, agents: [BOT] })), post: vi.fn(),
    patch: vi.fn(), delete: vi.fn(), openStream: vi.fn(() => new Promise(() => undefined)), forRuntime: () => api,
  };
  return api as unknown as ApiClient;
}

/** A workspace client whose Bot is the Company Brain and whose turns are admitted. */
function brainClient() {
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [] });
  vi.mocked(client.admitTurn).mockResolvedValue({ record: canonicalChatRecord, message: snapshot.messages[0]!,
    turn: snapshot.turns[0]!, run: snapshot.runs[0]!, admission: "accepted" });
  client.agents = { bots: { interactions: vi.fn(async () => []), tasks: vi.fn(async () => []), authority: vi.fn(async () => {
    throw new Error("offline");
  }) }, list: vi.fn(async () => ({ enabled: true, agents: [BOT] })) } as unknown as ChatAgentClient;
  return client;
}

async function send(text: string) {
  const composer = screen.getByRole("textbox", { name: "Start a chat" });
  await setSharedComposerText(composer, text);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

/** Renders what the Brain app's Chat tab renders: the host's view for one slot, inside the tab's runtime. */
function renderSlot(slot: BrainChatSlot) {
  function Slot() {
    const host = useDesktopBrainChatHost(true);
    return host ? <>{host.render(slot)}</> : null;
  }
  return render(<WorkSurfaceRuntimeProvider active><Slot /></WorkSurfaceRuntimeProvider>);
}

function slotFor(chatId: string | null): BrainChatSlot & { createChat: ReturnType<typeof vi.fn>; onChatChanged: ReturnType<typeof vi.fn> } {
  return {
    projectId: "proj_matrix_os", agentId: BOT.id, chatId, prompt: "Ask about matrix-os", promptDetail: PROMPT_DETAIL,
    createChat: vi.fn(async () => created), onChatChanged: vi.fn(),
  };
}

beforeAll(() => {
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
});
beforeEach(() => {
  runtime.client = null;
  stopDesktopProviderCatalogCoordinator();
  resetProviderPreferences({ hydrated: true });
  useTabs.setState(useTabs.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useConnection.setState({ status: "signed-in", handle: "operator", platformHost: "https://platform.test",
    runtimeSlot: "primary", authGeneration: 1, api: null });
});
afterEach(() => {
  cleanup();
  stopDesktopProviderCatalogCoordinator();
  vi.restoreAllMocks();
});

describe("Company Brain chat in Electron Desktop", () => {
  it("makes a draft's Chat through the host with no project picker, runs the Bot, and opens no Chat tab", async () => {
    const client = brainClient();
    const createChat = vi.fn(async () => created);
    const onActiveChatChanged = vi.fn();
    render(<CanonicalChatWorkspace client={client} projectId={null} initialView="draft" active externalNavigation
      catalog={{ ...providerCatalog, instances: [] }} createChat={createChat} botId={BOT.id}
      draftWelcome={{ title: "Ask about matrix-os", detail: PROMPT_DETAIL }}
      onActiveChatChanged={onActiveChatChanged} />);

    expect(await screen.findByRole("heading", { name: "Ask about matrix-os" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    // A brain thread keeps no project of its own: the picker would move it (PATCH .../project) or do nothing.
    expect(screen.queryByRole("button", { name: "Add to project" })).toBeNull();
    await send("What changed this week?");

    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(created.chat.id,
      expect.objectContaining({ selection: { instanceId: "matrix_bot_default", model: "auto" } }), expect.anything()));
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat).toHaveBeenCalledWith({ clientRequestId: expect.stringMatching(/^req_/), title: "What changed this week" });
    expect(client.create).not.toHaveBeenCalled();
    expect(client.updateProject).not.toHaveBeenCalled();
    await waitFor(() => expect(onActiveChatChanged).toHaveBeenCalledWith(created.chat.id, expect.anything()));
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("fills the brain slot with the tab's own workspace: one thread per draft, each turn reported, no tab opened", async () => {
    runtime.client = brainClient();
    const client = runtime.client as CanonicalChatClient;
    useConnection.setState({ api: fakeApi() });
    const slot = slotFor(null);
    renderSlot(slot);

    expect(await screen.findByRole("heading", { name: "Ask about matrix-os" })).toBeTruthy();
    expect(screen.getByText(PROMPT_DETAIL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to project" })).toBeNull();
    await send("What changed this week?");
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(created.chat.id, expect.anything(), expect.anything()));
    expect(slot.createChat).toHaveBeenCalledTimes(1);
    expect(client.create).not.toHaveBeenCalled();
    await waitFor(() => expect(slot.onChatChanged).toHaveBeenCalledWith(canonicalChatRecord.chat.id, canonicalChatRecord.chat.title));
    expect(slot.onChatChanged).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("opens a saved brain chat in the conversation view, with no Share, and leaves the open report to the slot", async () => {
    runtime.client = brainClient();
    const client = runtime.client as CanonicalChatClient;
    useConnection.setState({ api: fakeApi() });
    const slot = slotFor(canonicalChatRecord.chat.id);
    renderSlot(slot);

    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
    await waitFor(() => expect(client.getDetail).toHaveBeenCalledWith(canonicalChatRecord.chat.id, expect.anything()));
    expect(screen.queryByRole("button", { name: /^Project / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    // The workspace reports the Chat it opened; the slot picked it, so only later turns are passed on.
    expect(slot.onChatChanged).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("opens the same Chat in the Chat tab", async () => {
    useConnection.setState({ api: fakeApi() });
    let host: BrainChatHost | undefined;
    function Probe() {
      host = useDesktopBrainChatHost(true);
      return null;
    }
    render(<WorkSurfaceRuntimeProvider active><Probe /></WorkSurfaceRuntimeProvider>);
    await waitFor(() => expect(host).toBeDefined());
    expect((await host!.agents.list()).agents[0]?.id).toBe(BOT.id);
    act(() => host!.openInChat!("chat_brain0001"));
    const [tab] = useTabs.getState().tabs;
    expect(tab).toMatchObject({ kind: "work", workRoute: "chat", chatId: "chat_brain0001", chatView: "conversation" });
  });
});
