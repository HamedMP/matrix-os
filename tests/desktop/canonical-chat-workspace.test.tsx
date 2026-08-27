// @vitest-environment jsdom

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { snapshot, providerCatalog } = createCanonicalChatFixture("completed");
const resizeObserverCallbacks: ResizeObserverCallback[] = [];

class WorkspaceResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

function resizeChatWorkspace(width: number) {
  const workspace = document.querySelector<HTMLElement>('[data-slot="canonical-chat-workspace"]');
  if (!workspace) throw new Error("Canonical Chat workspace did not render");
  const entry = {
    target: workspace,
    contentRect: { width },
  } as unknown as ResizeObserverEntry;
  for (const callback of resizeObserverCallbacks) {
    callback([entry], {} as ResizeObserver);
  }
}

const record = {
  chat: {
    id: snapshot.chat.id,
    ownerScope: snapshot.chat.ownerScope,
    title: snapshot.chat.title,
    lifecycle: snapshot.chat.lifecycle,
    attention: snapshot.chat.attention,
    revision: snapshot.chat.revision,
    messageCount: snapshot.chat.messageCount,
    lastMessagePreview: snapshot.chat.lastMessagePreview,
    currentSelection: snapshot.chat.currentSelection,
    createdAt: snapshot.chat.createdAt,
    updatedAt: snapshot.chat.updatedAt,
  },
  projectId: "matrix-os",
  providerBinding: snapshot.chat.providerBinding,
};

function client(): CanonicalChatClient {
  return {
    list: vi.fn(async () => ({ items: [record] })),
    search: vi.fn(async () => ({ items: [record] })),
    getDetail: vi.fn(async () => ({
      record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    })),
    create: vi.fn(),
    updateProject: vi.fn(),
    delete: vi.fn(),
    admitTurn: vi.fn(),
    cancelRun: vi.fn(),
    retryTurn: vi.fn(),
  } as CanonicalChatClient;
}

describe("CanonicalChatWorkspace", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = WorkspaceResizeObserver;
  });

  beforeEach(() => {
    resizeObserverCallbacks.length = 0;
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
  });

  afterEach(cleanup);

  it.each([
    ["global", null, undefined],
    ["project", "matrix-os", "Matrix OS"],
  ] as const)("renders the same controller and shared surface for %s", async (_name, projectId, projectLabel) => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={projectId}
        projectLabel={projectLabel}
        active
        catalog={providerCatalog}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: snapshot.chat.title })).toBeTruthy());
    if (projectId === null) fireEvent.click(screen.getByRole("button", { name: snapshot.chat.title }));
    const surface = await screen.findByRole("region", { name: projectId ? "Project Chat" : "Global Chat" });
    expect(surface.getAttribute("data-chat-context")).toBe(projectId ? "project" : "global");
    expect(surface.querySelector('[data-slot="shared-chat-composer"]')).toBeTruthy();
  });

  it("renders Global Chat history beside the new-chat pane before a Chat is selected", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={null}
        active
        catalog={providerCatalog}
      />,
    );

    expect(await screen.findByRole("complementary", { name: "Global chats" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Global Chat" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What should we build today?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Explore and understand code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build a new feature, app, or tool" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review code and suggest changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix issues and failures" })).toBeTruthy();
    expect(screen.getByRole("button", { name: snapshot.chat.title })).toBeTruthy();
  });

  it("uses a single-column New Chat layout at the OS View minimum width", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={null}
        active
        catalog={providerCatalog}
      />,
    );

    await screen.findByRole("button", { name: "Explore and understand code" });
    act(() => resizeChatWorkspace(440));

    const workspace = document.querySelector<HTMLElement>('[data-slot="canonical-chat-workspace"]');
    const index = screen.getByRole("complementary", { name: "Global chats" }).parentElement;
    const starters = document.querySelector<HTMLElement>('[data-slot="chat-starter-cards"]');
    const composer = document.querySelector<HTMLElement>('[data-slot="shared-chat-composer"] .prompt-card');
    const newChatContent = document.querySelector<HTMLElement>('[data-slot="chat-new-chat-content"]');
    expect(workspace?.getAttribute("data-layout")).toBe("narrow");
    expect(workspace?.className).toContain("flex-col");
    expect(index?.getAttribute("data-layout")).toBe("narrow");
    expect(starters?.className).toContain("grid-cols-2");
    expect(screen.getByRole("button", { name: "Explore and understand code" }).className).toContain("min-h-24");
    expect(newChatContent?.className).toContain("overflow-y-auto");
    expect(composer?.getAttribute("data-layout")).toBe("narrow");
  });

  it("keeps an existing conversation usable at the OS View minimum width", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={null}
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply to chat" });
    act(() => resizeChatWorkspace(440));

    const workspace = document.querySelector<HTMLElement>('[data-slot="canonical-chat-workspace"]');
    const index = screen.getByRole("complementary", { name: "Global chats" }).parentElement;
    const composer = document.querySelector<HTMLElement>('[data-slot="shared-chat-composer"] .prompt-card');
    expect(workspace?.getAttribute("data-layout")).toBe("narrow");
    expect(workspace?.className).toContain("flex-col");
    expect(index?.getAttribute("data-layout")).toBe("narrow");
    expect(screen.getByRole("region", { name: "Messages" })).toBeTruthy();
    expect(composer?.getAttribute("data-layout")).toBe("narrow");
  });

  it("keeps Global Chat history visible while starting a draft and reopening an existing Chat", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={null}
        active
        catalog={providerCatalog}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    expect(screen.getByRole("complementary", { name: "Global chats" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Start a chat" })).toBeTruthy();

    const existingChat = screen.getByRole("button", { name: snapshot.chat.title });
    fireEvent.click(existingChat);
    expect(screen.getByRole("complementary", { name: "Global chats" })).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
    expect(existingChat.getAttribute("aria-current")).toBe("true");
    expect(existingChat.style.background).toBe("var(--bg-selected)");
  });

  it("reveals a delete action on Chat row hover and removes the confirmed Chat", async () => {
    const chatClient = client();
    const onChatDeleted = vi.fn();
    vi.mocked(chatClient.delete).mockResolvedValue({
      chatId: record.chat.id,
      deletedAt: "2026-08-26T12:00:00.000Z",
    });
    render(
      <CanonicalChatWorkspace
        client={chatClient}
        projectId={null}
        active
        catalog={providerCatalog}
        onChatDeleted={onChatDeleted}
      />,
    );

    const row = await screen.findByRole("button", { name: snapshot.chat.title });
    fireEvent.mouseEnter(row.parentElement!);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${snapshot.chat.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    await waitFor(() => expect(chatClient.delete).toHaveBeenCalledWith(
      record.chat.id,
      expect.stringMatching(/^req_/),
    ));
    expect(onChatDeleted).toHaveBeenCalledWith(record.chat.id);
    await waitFor(() => expect(screen.queryByRole("button", { name: snapshot.chat.title })).toBeNull());
  });

  it("shows a compact loading status without an empty outlined Chat-list panel", async () => {
    let resolveList!: (value: { items: typeof record[] }) => void;
    const loadingClient = client();
    vi.mocked(loadingClient.list).mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve;
    }));

    const { container } = render(
      <CanonicalChatWorkspace
        client={loadingClient}
        projectId={null}
        active
        catalog={providerCatalog}
      />,
    );

    const status = await screen.findByRole("status", { name: "Loading chats" });
    expect(status.textContent).toContain("Loading chats");
    expect(status.className).not.toContain("border");
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);

    await act(async () => resolveList({ items: [record] }));
  });

  it("reconciles a stale provider-default selection with the live Gateway catalog", async () => {
    const staleRecord = {
      ...record,
      chat: {
        ...record.chat,
        currentSelection: {
          instanceId: "codex_fixture",
          model: "provider-default",
        },
      },
    };
    const staleClient = client();
    vi.mocked(staleClient.list).mockResolvedValue({ items: [staleRecord] });
    vi.mocked(staleClient.getDetail).mockResolvedValue({
      record: staleRecord,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    render(
      <CanonicalChatWorkspace
        client={staleClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
      />,
    );

    const modelPicker = await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(modelPicker.textContent).toContain("GPT-5.6-Sol"));
    expect(modelPicker.textContent).not.toContain("Provider default");
  });

  it("shows the current Project on the shared composer before a Chat exists", async () => {
    const emptyClient = client();
    vi.mocked(emptyClient.list).mockResolvedValue({ items: [] });

    render(
      <CanonicalChatWorkspace
        client={emptyClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
      />,
    );

    expect(await screen.findByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
  });

  it("lets a Global New Chat choose its Project before the Chat is created", async () => {
    const emptyClient = client();
    vi.mocked(emptyClient.list).mockResolvedValue({ items: [] });
    useBoard.setState({
      projects: [{ id: "project_1", slug: "matrix-os", name: "Matrix OS", kind: "folder" }],
    });
    const api = {
      baseUrl: "https://matrix.test",
      get: vi.fn(),
      getText: vi.fn(),
      getBlob: vi.fn(),
      post: vi.fn(),
      postBytes: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      putBytes: vi.fn(),
      delete: vi.fn(),
      putText: vi.fn(),
    } as never;
    useConnection.setState({ api });

    render(
      <CanonicalChatWorkspace
        api={api}
        client={emptyClient}
        projectId={null}
        active
        catalog={providerCatalog}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to project" }));
    fireEvent.click(await screen.findByRole("option", { name: "Matrix OS, Folder" }));

    expect(await screen.findByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
  });

  it("opens a Global draft in its selected Project after the first Turn is admitted", async () => {
    const emptyClient = client();
    vi.mocked(emptyClient.list).mockResolvedValue({ items: [] });
    const createdRecord = {
      ...record,
      chat: { ...record.chat, revision: 0, messageCount: 0 },
      projectId: "project_1",
      providerBinding: undefined,
    };
    const admittedRecord = { ...record, projectId: "project_1" };
    vi.mocked(emptyClient.create).mockResolvedValue(createdRecord);
    vi.mocked(emptyClient.admitTurn).mockResolvedValue({
      record: admittedRecord,
      message: snapshot.messages[0],
      turn: snapshot.turns[0],
      run: snapshot.runs[0],
      admission: "accepted",
    });
    useBoard.setState({
      projects: [{ id: "project_1", slug: "matrix-os", name: "Matrix OS", kind: "folder" }],
    });
    const api = {
      baseUrl: "https://matrix.test",
      get: vi.fn(),
      getText: vi.fn(),
      getBlob: vi.fn(),
      post: vi.fn(),
      postBytes: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      putBytes: vi.fn(),
      delete: vi.fn(),
      putText: vi.fn(),
    } as never;
    useConnection.setState({ api });
    const onProjectChanged = vi.fn();
    const onActiveChatChanged = vi.fn();

    render(
      <CanonicalChatWorkspace
        api={api}
        client={emptyClient}
        projectId={null}
        active
        catalog={providerCatalog}
        onProjectChanged={onProjectChanged}
        onActiveChatChanged={onActiveChatChanged}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    fireEvent.click(screen.getByRole("option", { name: "Matrix OS, Folder" }));
    await setSharedComposerText(screen.getByRole("textbox", { name: "Start a chat" }), "Inspect Matrix OS");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onProjectChanged).toHaveBeenCalledWith(
      snapshot.chat.id,
      "project_1",
      snapshot.chat.title,
    ));
    expect(onActiveChatChanged).not.toHaveBeenCalledWith(snapshot.chat.id, expect.anything());
  });

  it("renders the shared inspector slot beside the canonical Chat surface", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
        inspector={<aside aria-label="Conversation tools">Inspector</aside>}
      />,
    );

    expect(await screen.findByRole("region", { name: "Project Chat" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Conversation tools" })).toBeTruthy();
  });

  it("shows a conversation loading state instead of flashing the New Chat hero", async () => {
    let resolveDetail!: (value: Awaited<ReturnType<CanonicalChatClient["getDetail"]>>) => void;
    const delayedClient = client();
    vi.mocked(delayedClient.getDetail).mockImplementation(() => new Promise((resolve) => {
      resolveDetail = resolve;
    }));

    render(
      <CanonicalChatWorkspace
        client={delayedClient}
        projectId={null}
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    expect(await screen.findByRole("status", { name: "Loading chat" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What should we build today?" })).toBeNull();

    await act(async () => resolveDetail({
      record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    }));
  });

  it("keeps Project New chat detached from the first existing Chat after route sync", async () => {
    const routeClient = client();

    function Harness() {
      const [activeChatId, setActiveChatId] = useState<string | null>(snapshot.chat.id);
      return (
        <CanonicalChatWorkspace
          client={routeClient}
          projectId="matrix-os"
          projectLabel="Matrix OS"
          initialChatId={activeChatId ?? undefined}
          active
          catalog={providerCatalog}
          onActiveChatChanged={(chatId) => setActiveChatId(chatId)}
        />
      );
    }

    render(<Harness />);

    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(screen.getByRole("textbox", { name: "Start a chat" })).toBeTruthy();
    expect(routeClient.list).toHaveBeenCalledTimes(1);
    expect(routeClient.getDetail).toHaveBeenCalledTimes(1);
  });

  it("does not let stale Global Chat detail overwrite a requested New Chat draft", async () => {
    const routeClient = client();
    const reportedIds: Array<string | null> = [];

    function Harness() {
      const [route, setRoute] = useState<{
        chatId?: string;
        view: "draft" | "conversation";
      }>({ chatId: snapshot.chat.id, view: "conversation" });
      return (
        <CanonicalChatWorkspace
          client={routeClient}
          projectId={null}
          initialChatId={route.chatId}
          initialView={route.view}
          active
          catalog={providerCatalog}
          onActiveChatChanged={(chatId) => {
            reportedIds.push(chatId);
            setRoute(chatId
              ? { chatId, view: "conversation" }
              : { view: "draft" });
          }}
        />
      );
    }

    render(<Harness />);

    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(screen.getByRole("textbox", { name: "Start a chat" })).toBeTruthy();
    expect(reportedIds).toEqual([null]);
  });

  it("does not submit uploaded attachments after the selected runtime changes", async () => {
    let resolveUpload!: (value: { ok: true; path: string; size: number }) => void;
    const api = {
      baseUrl: "https://matrix.test",
      get: vi.fn(),
      getText: vi.fn(),
      getBlob: vi.fn(),
      post: vi.fn(),
      postBytes: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      putBytes: vi.fn(() => new Promise((resolve) => { resolveUpload = resolve; })),
      delete: vi.fn(),
      putText: vi.fn(),
    } as never;
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [] });
    const onActiveChatChanged = vi.fn();
    render(
      <CanonicalChatWorkspace
        api={api}
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
        onActiveChatChanged={onActiveChatChanged}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Start a chat" });
    await setSharedComposerText(editor, "Inspect the attachment");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.putBytes).toHaveBeenCalledTimes(1));

    advanceRuntimeGeneration();
    await act(async () => {
      const uploadPath = vi.mocked(api.putBytes).mock.calls[0]?.[0] as string;
      const path = decodeURIComponent(uploadPath.split("path=")[1] ?? "");
      resolveUpload({
        ok: true,
        path,
        size: file.size,
      });
    });

    await waitFor(() => expect(routeClient.admitTurn).not.toHaveBeenCalled());
    expect(routeClient.create).not.toHaveBeenCalled();
    expect(onActiveChatChanged).not.toHaveBeenCalled();
  });
});
