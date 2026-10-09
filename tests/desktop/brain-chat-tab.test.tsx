// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainChatHost, BrainChatSlot, ChatAgentClient } from "@matrix-os/ui";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { stopDesktopProviderCatalogCoordinator } from "@desktop/renderer/src/features/chat/provider-catalog-coordinator";
import { useDesktopBrainChatHost } from "@desktop/renderer/src/features/brain/DesktopBrainChat";
import { useRetainedComposerDrafts } from "@desktop/renderer/src/features/chat/retained-composer-drafts";
import { WorkSurfaceRuntimeProvider } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import type { CanonicalChatClient, CanonicalChatInvalidation } from "@desktop/renderer/src/lib/canonical-chat-client";
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

async function send(text: string, name = "Start a chat") {
  const composer = screen.getByRole("textbox", { name });
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

/** Holds the slot like the Brain app's Chat tab: a draft's thread is shown as soon as it exists, then each report. */
function renderLiveSlot(chatId: string | null) {
  const createChat = vi.fn(async () => created);
  const onChatChanged = vi.fn();
  function Slot() {
    const host = useDesktopBrainChatHost(true);
    const [shown, setShown] = React.useState(chatId);
    if (!host) return null;
    return <>{host.render({
      ...slotFor(shown),
      createChat: async (input) => {
        const record = await createChat(input);
        setShown(record.chat.id);
        return record;
      },
      onChatChanged: (id, title) => {
        setShown(id);
        onChatChanged(id, title);
      },
    })}</>;
  }
  render(<WorkSurfaceRuntimeProvider active><Slot /></WorkSurfaceRuntimeProvider>);
  return { createChat, onChatChanged };
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

  it("opens a saved brain chat in the conversation view, with no Share, and reports its turns but not its opening", async () => {
    runtime.client = brainClient();
    const client = runtime.client as CanonicalChatClient;
    useConnection.setState({ api: fakeApi() });
    const slot = slotFor(canonicalChatRecord.chat.id);
    renderSlot(slot);

    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
    await waitFor(() => expect(client.getDetail).toHaveBeenCalledWith(canonicalChatRecord.chat.id, expect.anything()));
    expect(screen.queryByRole("button", { name: /^Project / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    // Opening reports nothing (the slot picked this Chat); the first turn is reported, so the list sorts and dates it.
    expect(slot.onChatChanged).not.toHaveBeenCalled();
    await send("And since then?", "Reply to chat");
    await waitFor(() => expect(slot.onChatChanged).toHaveBeenCalledWith(canonicalChatRecord.chat.id, canonicalChatRecord.chat.title));
    expect(slot.onChatChanged).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("keeps following a saved brain chat that is not on the first page of chats", async () => {
    const client = brainClient();
    let listPage!: (page: { items: [] }) => void;
    // The list's first page leaves this thread out (older than its 100 chats), and answers after the thread loads.
    vi.mocked(client.list).mockReturnValue(new Promise((resolve) => { listPage = resolve; }));
    const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
    const eventSource = { subscribe: (listener: (event: CanonicalChatInvalidation) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    } };
    const chatId = canonicalChatRecord.chat.id;
    const loads = () => vi.mocked(client.getDetail).mock.calls.filter(([, options]) => options?.limit === 200).length;
    render(<CanonicalChatWorkspace client={client} eventSource={eventSource} projectId={null} initialChatId={chatId}
      initialView="conversation" active={false} live externalNavigation catalog={{ ...providerCatalog, instances: [] }}
      createChat={vi.fn()} botId={BOT.id} />);
    expect(await screen.findByText("Build the canonical Chat contract.")).toBeTruthy();
    await act(async () => { listPage({ items: [] }); });
    // The shown thread is neither dropped nor loaded again, and its events still refresh it.
    expect(screen.getByText("Build the canonical Chat contract.")).toBeTruthy();
    expect(loads()).toBe(1);
    act(() => { for (const listener of [...listeners]) listener({ type: "chat.changed", chatId, cursor: 9, revision: 9, eventType: "run.message" }); });
    await waitFor(() => expect(loads()).toBe(2));
  });

  it("keeps a refused first question in the composer with the reason, then sends it into the thread", async () => {
    runtime.client = brainClient();
    const client = runtime.client as CanonicalChatClient;
    vi.mocked(client.admitTurn).mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useConnection.setState({ api: fakeApi() });
    const { createChat, onChatChanged } = renderLiveSlot(null);

    expect(await screen.findByRole("heading", { name: "Ask about matrix-os" })).toBeTruthy();
    await send("What changed this week?");
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(created.chat.id, expect.anything(), expect.anything()));
    expect(await screen.findByText(/could not be sent/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Start a chat" }).textContent).toBe("What changed this week?");
    expect(onChatChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.admitTurn).mock.calls[1]?.[0]).toBe(created.chat.id);
    await waitFor(() => expect(onChatChanged).toHaveBeenCalledWith(canonicalChatRecord.chat.id, canonicalChatRecord.chat.title));
    expect((await screen.findByRole("textbox", { name: "Reply to chat" })).textContent).toBe("");
    expect(createChat.mock.results.every((result) => result.type === "return")).toBe(true);
  });

  it("keeps each project's brain draft apart from the Chat tab's new-chat draft", async () => {
    useRetainedComposerDrafts.setState({ identity: null, drafts: {}, sequence: 0 });
    useConnection.setState({ userId: "user_operator", api: fakeApi() });
    runtime.client = brainClient();
    const client = runtime.client as CanonicalChatClient;
    const chatTab = () => render(<CanonicalChatWorkspace client={client} projectId={null} initialView="draft" active
      catalog={{ ...providerCatalog, instances: [] }} />);
    const composer = () => screen.findByRole("textbox", { name: "Start a chat" });

    const tab = chatTab();
    await setSharedComposerText(await composer(), "A Chat tab draft");
    tab.unmount();
    const brain = renderSlot(slotFor(null));
    expect((await composer()).textContent).toBe("");
    await setSharedComposerText(await composer(), "A brain question");
    brain.unmount();
    const other = renderSlot({ ...slotFor(null), projectId: "proj_other" });
    expect((await composer()).textContent).toBe("");
    other.unmount();

    renderSlot(slotFor(null));
    expect((await composer()).textContent).toBe("A brain question");
    cleanup();
    chatTab();
    expect((await composer()).textContent).toBe("A Chat tab draft");
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
