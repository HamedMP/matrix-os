// @vitest-environment jsdom

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import type {
  CanonicalChatEventSource,
  CanonicalChatInvalidation,
} from "@desktop/renderer/src/lib/canonical-chat-client";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import {
  canonicalChatRecord as record,
  createCanonicalChatWorkspaceClient as client,
  providerCatalog,
  snapshot,
} from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("CanonicalChatWorkspace", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = WorkspaceResizeObserver;
  });

  beforeEach(() => {
    resizeObserverCallbacks.length = 0;
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
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

  it("uses the same content width for the transcript and canonical composer", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const transcript = await screen.findByRole("log");
    const composer = screen.getByRole("textbox", { name: "Reply to chat" })
      .closest('[data-slot="shared-chat-composer"]');
    expect(composer?.parentElement).toBeTruthy();
    expect(transcript.className).toContain("max-w-[868px]");
    expect(composer?.parentElement?.className).toContain("max-w-[868px]");
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

  it("submits live approval actions from the canonical transcript", async () => {
    const approval = createCanonicalChatFixture("approval_required").snapshot;
    const approvalRecord = {
      chat: {
        ...approval.chat,
        providerBinding: undefined,
        activeRun: undefined,
        project: undefined,
      },
      projectId: "matrix-os",
      providerBinding: approval.chat.providerBinding,
      activeRun: approval.chat.activeRun,
    };
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [approvalRecord] });
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: approvalRecord,
      messages: approval.messages,
      turns: approval.turns,
      runs: approval.runs,
      activities: [...approval.activities, {
        id: "activity_approval_action",
        chatId: approval.chat.id,
        runId: approval.runs[0]!.id,
        occurredAt: approval.runs[0]!.updatedAt,
        type: "approval.requested",
        approvalId: "appr_command",
        title: "Run command",
        risk: "medium",
        allowedDecisions: ["approve", "decline"],
      }],
    });
    vi.mocked(routeClient.submitApproval).mockResolvedValue({
      approvalId: "appr_command",
      decision: "approve",
      submission: "accepted",
    });

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={approval.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Approve Run command" }));

    await waitFor(() => expect(routeClient.submitApproval).toHaveBeenCalledWith(
      approval.chat.id,
      approval.runs[0]!.id,
      "appr_command",
      { clientRequestId: expect.any(String), decision: "approve" },
    ));
  });

  it.each([
    ["Global", null, undefined],
    ["Project", "matrix-os", "Matrix OS"],
  ] as const)("keeps %s prompt suggestions after a Terminal pre-creates the draft Chat", async (
    _scope,
    projectId,
    projectLabel,
  ) => {
    const onActiveChatChanged = vi.fn();
    const routeClient = client();
    const view = render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId={projectId}
        projectLabel={projectLabel}
        active
        catalog={providerCatalog}
        externalNavigation
        initialView="draft"
        onActiveChatChanged={onActiveChatChanged}
      />,
    );

    expect(await screen.findByRole("button", { name: "Explore and understand code" })).toBeTruthy();

    view.rerender(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId={projectId}
        projectLabel={projectLabel}
        active
        catalog={providerCatalog}
        externalNavigation
        initialChatId={snapshot.chat.id}
        initialView="draft"
        onActiveChatChanged={onActiveChatChanged}
      />,
    );

    await waitFor(() => expect(routeClient.getDetail).toHaveBeenCalledWith(snapshot.chat.id, { limit: 200 }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(screen.getByRole("button", { name: "Explore and understand code" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Start a chat" })).toBeTruthy();
    expect(onActiveChatChanged).not.toHaveBeenCalled();
  });

  it.each([
    ["Global", null, "Global chats"],
    ["Project", "matrix-os", "Project chats"],
  ] as const)("suppresses the legacy %s navigation when an external rail owns Chat selection", async (
    _name,
    projectId,
    navigationLabel,
  ) => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={projectId}
        projectLabel={projectId ? "Matrix OS" : undefined}
        active
        catalog={providerCatalog}
        externalNavigation
      />,
    );

    expect(await screen.findByRole("region", { name: projectId ? "Project Chat" : "Global Chat" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: navigationLabel })).toBeNull();
  });

  it("matches the Figma typography for the Global Chat rail and starter actions", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={null}
        active
        catalog={providerCatalog}
      />,
    );

    const heading = screen.getByRole("heading", { name: "Chats" });
    expect(heading.className).toContain("text-[16px]");
    expect(heading.className).toContain("font-medium");
    expect(heading.className).toContain("leading-[16px]");
    expect(heading.className).toContain("tracking-[-0.4px]");

    const chat = await screen.findByRole("button", { name: snapshot.chat.title });
    const chatTitle = within(chat).getByText(snapshot.chat.title);
    const activity = chat.parentElement?.querySelector("time");
    expect(chatTitle.className).toContain("text-[14px]");
    expect(chatTitle.className).toContain("leading-[20px]");
    expect(activity?.className).toContain("text-[12px]");
    expect(activity?.className).toContain("leading-[16px]");
    expect(activity?.className).toContain("tracking-[0.12px]");

    const starter = screen.getByRole("button", { name: "Explore and understand code" });
    const starterLabel = within(starter).getByText("Explore and understand code");
    expect(starterLabel.className).toContain("text-[13px]");
    expect(starterLabel.className).toContain("font-medium");
    expect(starterLabel.className).toContain("leading-[18px]");
  });

  it("uses the same explicit typography contract in the Project Chat rail", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
      />,
    );

    const heading = screen.getByRole("heading", { name: "Matrix OS" });
    expect(heading.className).toContain("text-[14px]");
    expect(heading.className).toContain("font-semibold");
    expect(heading.className).toContain("leading-[20px]");

    const chat = await screen.findByRole("button", { name: snapshot.chat.title });
    const chatTitle = within(chat).getByText(snapshot.chat.title);
    const preview = within(chat).getByText(snapshot.chat.lastMessagePreview!);
    expect(chatTitle.className).toContain("text-[14px]");
    expect(chatTitle.className).toContain("leading-[20px]");
    expect(preview.className).toContain("text-[12px]");
    expect(preview.className).toContain("leading-[16px]");

    const hero = screen.getByRole("heading", { name: "What should we build today?" });
    expect(hero.className).toContain("text-[24px]");
    expect(hero.className).toContain("font-medium");
    expect(hero.className).toContain("leading-[32px]");
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
    const starterScroll = document.querySelector<HTMLElement>('[data-slot="chat-starter-scroll"]');
    const starterStack = document.querySelector<HTMLElement>('[data-slot="chat-starter-stack"]');
    const composer = document.querySelector<HTMLElement>('[data-slot="shared-chat-composer"] .prompt-card');
    const newChatContent = document.querySelector<HTMLElement>('[data-slot="chat-new-chat-content"]');
    expect(workspace?.getAttribute("data-layout")).toBe("narrow");
    expect(workspace?.className).toContain("flex-col");
    expect(index?.getAttribute("data-layout")).toBe("narrow");
    expect(starters?.className).toContain("grid-cols-1");
    expect(screen.getByRole("button", { name: "Explore and understand code" }).className).toContain("min-h-20");
    expect(starterScroll?.className).toContain("overflow-y-auto");
    expect(starterScroll?.className).toContain("items-start");
    expect(starterStack?.className).toContain("my-auto");
    expect(starterScroll?.style.scrollbarGutter).toBe("stable");
    expect(newChatContent?.className).toContain("overflow-hidden");
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

  it("focuses the prompt when the surrounding Chat shell requests it", async () => {
    act(() => useCodingAgentWorkspace.getState().requestComposerFocus());
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={null}
        initialView="draft"
        active
        catalog={providerCatalog}
      />,
    );
    const prompt = await screen.findByRole("textbox", { name: "Start a chat" });

    await waitFor(() => expect(document.activeElement).toBe(prompt));
  });

  it("keeps the focused prompt editable during a background full refresh", async () => {
    let listener: ((event: CanonicalChatInvalidation) => void) | undefined;
    const eventSource: Pick<CanonicalChatEventSource, "subscribe"> = {
      subscribe(next) {
        listener = next;
        return { dispose: () => { listener = undefined; } };
      },
    };
    let resolveRefresh!: (value: { items: typeof record[] }) => void;
    const refresh = new Promise<{ items: typeof record[] }>((resolve) => {
      resolveRefresh = resolve;
    });
    const routeClient = client();
    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        initialChatId={record.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
        eventSource={eventSource}
      />,
    );
    const prompt = await screen.findByRole("textbox", { name: "Reply to chat" });
    prompt.focus();
    vi.mocked(routeClient.list).mockImplementationOnce(() => refresh);

    act(() => listener?.({ type: "chat.full_refresh", cursor: 2 }));
    await waitFor(() => expect(routeClient.list).toHaveBeenCalledTimes(2));

    expect(prompt.getAttribute("contenteditable")).toBe("true");
    expect(document.activeElement).toBe(prompt);
    await act(async () => resolveRefresh({ items: [record] }));
  });

  it("reveals a delete action on Chat row hover and removes the confirmed Chat", async () => {
    const chatClient = client();
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

  it("makes the Chat surface inert while a narrow inspector pane is exclusive", async () => {
    const { container } = render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
        inspectorExclusive
        inspector={<aside aria-label="Conversation tools">Inspector</aside>}
      />,
    );

    await screen.findByRole("button", { name: snapshot.chat.title });
    const chat = container.querySelector<HTMLElement>("[data-slot='shared-chat-surface']");
    expect(chat).toBeTruthy();
    expect(chat?.getAttribute("aria-hidden")).toBe("true");
    expect(chat?.hasAttribute("inert")).toBe(true);
    expect(chat?.hidden).toBe(true);
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

  it("does not report stale detail after switching between Chats in the same Project", async () => {
    const firstChatId = snapshot.chat.id;
    const secondChatId = "chat_same_project_second";
    const secondRecord = {
      ...record,
      chat: { ...record.chat, id: secondChatId, title: "Second project chat" },
    };
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [record, secondRecord] });
    vi.mocked(routeClient.getDetail).mockImplementation(async (chatId) => ({
      record: chatId === secondChatId ? secondRecord : record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    }));
    const reportedIds: string[] = [];

    function Harness() {
      const [activeChatId, setActiveChatId] = useState(firstChatId);
      return (
        <>
          <button type="button" onClick={() => setActiveChatId(secondChatId)}>Switch project chat</button>
          <CanonicalChatWorkspace
            client={routeClient}
            projectId="matrix-os"
            projectLabel="Matrix OS"
            initialChatId={activeChatId}
            active
            externalNavigation
            catalog={providerCatalog}
            onActiveChatChanged={(chatId) => {
              if (!chatId) return;
              reportedIds.push(chatId);
              setActiveChatId(chatId);
            }}
          />
        </>
      );
    }

    render(<Harness />);

    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch project chat" }));

    await waitFor(() => expect(routeClient.getDetail).toHaveBeenCalledWith(secondChatId, { limit: 200 }));
    await waitFor(() => expect(reportedIds).toContain(secondChatId));
    expect(reportedIds).not.toContain(firstChatId);
    expect(vi.mocked(routeClient.getDetail).mock.calls.at(-1)?.[0]).toBe(secondChatId);
  });

  it("keeps an independent unsent prompt for each Chat", async () => {
    const firstChatId = snapshot.chat.id;
    const secondChatId = "chat_with_independent_draft";
    const secondRecord = {
      ...record,
      chat: { ...record.chat, id: secondChatId, title: "Independent draft chat" },
    };
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [record, secondRecord] });
    vi.mocked(routeClient.getDetail).mockImplementation(async (chatId) => ({
      record: chatId === secondChatId ? secondRecord : record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    }));
    vi.mocked(routeClient.admitTurn).mockResolvedValue({
      record: { ...record, chat: { ...record.chat, revision: record.chat.revision + 1 } },
      message: { ...snapshot.messages[0]!, id: "message_independent_draft" },
      turn: {
        ...snapshot.turns[0]!,
        id: "turn_independent_draft",
        userMessageId: "message_independent_draft",
      },
      run: {
        ...snapshot.runs[0]!,
        id: "run_independent_draft",
        turnId: "turn_independent_draft",
      },
      admission: "accepted",
    });

    const view = render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={firstChatId}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "1");
    fireEvent.click(screen.getByRole("button", { name: secondRecord.chat.title }));
    await waitFor(() => expect(routeClient.getDetail).toHaveBeenCalledWith(secondChatId, { limit: 200 }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe(""));

    await setSharedComposerText(screen.getByRole("textbox", { name: "Reply to chat" }), "2");
    fireEvent.click(screen.getByRole("button", { name: record.chat.title }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Start a chat" }).textContent).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: record.chat.title }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(routeClient.admitTurn).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: secondRecord.chat.title }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe("2"));

    const replacementClient = client();
    vi.mocked(replacementClient.list).mockResolvedValue({ items: [record, secondRecord] });
    vi.mocked(replacementClient.getDetail).mockResolvedValue({
      record: secondRecord,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });
    view.rerender(
      <CanonicalChatWorkspace
        client={replacementClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={secondChatId}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe(""));
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

  it("does not let the previous Chat detail revert an external route change", async () => {
    const nextRecord = {
      ...record,
      chat: {
        ...record.chat,
        id: "chat_next_route",
        title: "Next routed chat",
        revision: Math.max(0, record.chat.revision - 1),
      },
    };
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [record, nextRecord] });
    vi.mocked(routeClient.getDetail).mockImplementation(async (chatId) => {
      if (chatId === nextRecord.chat.id) return new Promise(() => undefined);
      return {
        record,
        messages: snapshot.messages,
        turns: snapshot.turns,
        runs: snapshot.runs,
        activities: snapshot.activities,
      };
    });
    let navigate!: (chatId: string) => void;
    let routedChatId = record.chat.id;

    function Harness() {
      const [chatId, setChatId] = useState(record.chat.id);
      navigate = setChatId;
      routedChatId = chatId;
      return (
        <CanonicalChatWorkspace
          client={routeClient}
          projectId={null}
          initialChatId={chatId}
          initialView="conversation"
          active
          catalog={providerCatalog}
          externalNavigation
          onActiveChatChanged={(nextChatId) => {
            if (nextChatId) setChatId(nextChatId);
          }}
        />
      );
    }

    render(<Harness />);
    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();

    act(() => navigate(nextRecord.chat.id));
    await waitFor(() => expect(routeClient.getDetail).toHaveBeenCalledWith(
      nextRecord.chat.id,
      { limit: 200 },
    ));

    expect(routedChatId).toBe(nextRecord.chat.id);
  });

  it.each([
    ["starting another Chat in the same Project", false],
    ["deleting the last Chat in the Project", true],
  ] as const)("keeps New Chat visible after %s", async (_scenario, emptyProject) => {
    const routeClient = client();
    const reportedIds: Array<string | null> = [];

    function Harness() {
      const [route, setRoute] = useState<{
        chatId?: string;
        view: "draft" | "conversation";
      }>({ chatId: snapshot.chat.id, view: "conversation" });
      return (
        <>
          <button type="button" onClick={() => {
            if (emptyProject) vi.mocked(routeClient.list).mockResolvedValue({ items: [] });
            setRoute({ view: "draft" });
          }}>Open project draft</button>
          <CanonicalChatWorkspace
            client={routeClient}
            projectId="matrix-os"
            projectLabel="Matrix OS"
            initialChatId={route.chatId}
            initialView={route.view}
            active
            externalNavigation
            catalog={providerCatalog}
            onActiveChatChanged={(chatId) => {
              reportedIds.push(chatId);
              if (chatId) setRoute({ chatId, view: "conversation" });
            }}
          />
        </>
      );
    }

    render(<Harness />);

    expect(await screen.findByRole("textbox", { name: "Reply to chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open project draft" }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(screen.getByRole("button", { name: "Explore and understand code" })).toBeTruthy();
    expect(reportedIds).toEqual([]);
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

  it("submits uploaded screenshots as canonical image attachments with a safe owner reference", async () => {
    const api = {
      baseUrl: "https://matrix.test",
      get: vi.fn(),
      getText: vi.fn(),
      getBlob: vi.fn(),
      post: vi.fn(),
      postBytes: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      putBytes: vi.fn(async (url: string, file: File) => ({
        ok: true,
        path: decodeURIComponent(url.split("path=")[1] ?? ""),
        size: file.size,
      })),
      delete: vi.fn(),
      putText: vi.fn(),
    } as never;
    const routeClient = client();
    vi.mocked(routeClient.admitTurn).mockResolvedValue({
      record,
      message: snapshot.messages[0]!,
      turn: snapshot.turns[0]!,
      run: snapshot.runs[0]!,
      admission: "accepted",
    });
    render(
      <CanonicalChatWorkspace
        api={api}
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Inspect this screenshot");
    const file = new File(["png bytes"], "Screenshot.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(routeClient.admitTurn).toHaveBeenCalled());
    const request = vi.mocked(routeClient.admitTurn).mock.calls[0]![1];
    expect(request.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Inspect this screenshot" }),
      expect.objectContaining({
        type: "attachment_reference",
        attachmentId: expect.stringMatching(/^desktop_upload_/),
        kind: "image",
        label: "Screenshot.png",
        mimeType: "image/png",
        ownerReference: expect.stringMatching(/^temporary\/desktop-chat\/.+-Screenshot\.png$/),
      }),
    ]));
    expect(request.parts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource_reference" }),
    ]));
  });

  it("uses Codex-style Stop/Send queueing with an attached compact queue card", async () => {
    const running = createCanonicalChatFixture("running").snapshot;
    const activeRunRecord = {
      ...running.runs[0]!,
      capabilitySnapshot: {
        ...running.runs[0]!.capabilitySnapshot,
        steering: "same_run" as const,
      },
    };
    const runningRecord = {
      chat: {
        id: running.chat.id,
        ownerScope: running.chat.ownerScope,
        title: running.chat.title,
        lifecycle: running.chat.lifecycle,
        attention: running.chat.attention,
        revision: running.chat.revision,
        messageCount: running.chat.messageCount,
        lastMessagePreview: running.chat.lastMessagePreview,
        currentSelection: running.chat.currentSelection,
        createdAt: running.chat.createdAt,
        updatedAt: running.chat.updatedAt,
      },
      projectId: "matrix-os",
      providerBinding: running.chat.providerBinding,
      activeRun: running.chat.activeRun,
    };
    const queuedTurn = (id: string, position: number, text: string) => ({
      id,
      chatId: running.chat.id,
      clientRequestId: `req_${id}`,
      position,
      parts: [{ type: "text" as const, text }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project" as const, projectId: "matrix-os" },
      createdAt: "2026-08-31T02:00:00.000Z",
      updatedAt: "2026-08-31T02:00:00.000Z",
    });
    const first = queuedTurn("qturn_workspace_1", 1, "First queued turn");
    const second = queuedTurn("qturn_workspace_2", 2, "Second queued turn");
    const editedSecond = { ...second, parts: [{ type: "text" as const, text: "Edited second queued turn" }] };
    const third = queuedTurn("qturn_workspace_3", 3, "Third queued turn");
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [runningRecord] });
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: runningRecord,
      messages: running.messages,
      turns: running.turns,
      runs: [activeRunRecord],
      activities: running.activities,
      queuedTurns: [first, second],
    });
    let finishSteer!: (value: Awaited<ReturnType<CanonicalChatClient["steerQueuedTurn"]>>) => void;
    const steering = new Promise<Awaited<ReturnType<CanonicalChatClient["steerQueuedTurn"]>>>((resolve) => {
      finishSteer = resolve;
    });
    vi.mocked(routeClient.steerQueuedTurn).mockReturnValue(steering);
    const steered = {
      runId: activeRunRecord.id,
      turnId: activeRunRecord.turnId,
      message: {
        id: "msg_workspace_steer",
        chatId: running.chat.id,
        seq: 2,
        role: "user",
        state: "committed",
        turnId: activeRunRecord.turnId,
        runId: activeRunRecord.id,
        parts: first.parts,
        createdAt: "2026-08-31T02:00:01.000Z",
      },
      steering: "accepted" as const,
    };
    let finishQueue!: (value: Awaited<ReturnType<CanonicalChatClient["queueTurn"]>>) => void;
    const queueMutation = new Promise<Awaited<ReturnType<CanonicalChatClient["queueTurn"]>>>((resolve) => {
      finishQueue = resolve;
    });
    vi.mocked(routeClient.queueTurn).mockReturnValue(queueMutation);
    vi.mocked(routeClient.updateQueuedTurn).mockResolvedValue({
      queuedTurn: editedSecond,
    });
    let finishReorder!: (value: Awaited<ReturnType<CanonicalChatClient["reorderQueuedTurns"]>>) => void;
    const reorderMutation = new Promise<Awaited<ReturnType<CanonicalChatClient["reorderQueuedTurns"]>>>((resolve) => {
      finishReorder = resolve;
    });
    vi.mocked(routeClient.reorderQueuedTurns).mockReturnValue(reorderMutation);
    vi.mocked(routeClient.cancelQueuedTurn).mockResolvedValue({
      queuedTurnId: second.id,
      queueDepth: 2,
      cancellation: "cancelled",
    });

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={running.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    const queuePanel = await screen.findByRole("region", { name: "Queued turns" });
    expect(queuePanel.getAttribute("data-attached-to-composer")).toBe("true");
    expect(queuePanel.getAttribute("data-queue-card-style")).toBe("codex");
    expect(queuePanel.getAttribute("data-queue-density")).toBe("compact");
    expect(within(queuePanel).getAllByRole("listitem")[0]?.className).toContain("min-h-10");
    expect(screen.queryByText("Up next")).toBeNull();
    expect(screen.queryByText("2 turns")).toBeNull();
    expect(screen.getByText("First queued turn")).toBeTruthy();
    expect(screen.getByText("Second queued turn")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Steer current run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue next" })).toBeNull();

    await setSharedComposerText(editor, "Third queued turn");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(routeClient.queueTurn).toHaveBeenCalledWith(
      running.chat.id,
      expect.objectContaining({ parts: [{ type: "text", text: "Third queued turn" }] }),
    ));
    expect(editor.textContent).toBe("");
    expect(within(queuePanel).queryByText("Third queued turn")).toBeNull();
    finishQueue({ queuedTurn: third, queueDepth: 3 });
    await waitFor(() => expect(within(queuePanel).getByText("Third queued turn")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Second queued turn" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Second queued turn" }));
    await waitFor(() => expect(editor.textContent).toContain("Second queued turn"));
    await setSharedComposerText(editor, "Edited second queued turn");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(routeClient.updateQueuedTurn).toHaveBeenCalledWith(
      running.chat.id,
      second.id,
      expect.objectContaining({ parts: [{ type: "text", text: "Edited second queued turn" }] }),
    ));

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Edited second queued turn" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "Edit Edited second queued turn" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Move .* (up|down)/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    const firstDragHandle = screen.getByRole("button", { name: "Reorder First queued turn" });
    const secondRow = screen.getByText("Edited second queued turn").closest("li");
    if (!secondRow) throw new Error("Second queued turn row not found");
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      setData: vi.fn(),
    } as unknown as DataTransfer;
    fireEvent.dragStart(firstDragHandle, { dataTransfer });
    fireEvent.dragOver(secondRow, { dataTransfer });
    fireEvent.drop(secondRow, { dataTransfer });
    expect(within(queuePanel).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Edited second queued turn"),
      expect.stringContaining("First queued turn"),
      expect.stringContaining("Third queued turn"),
    ]);
    await waitFor(() => expect(routeClient.reorderQueuedTurns).toHaveBeenCalledWith(
      running.chat.id,
      expect.objectContaining({ queuedTurnIds: [second.id, first.id, third.id] }),
    ));
    finishReorder({ queuedTurns: [editedSecond, first, third] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Reorder First queued turn" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancel Edited second queued turn" }));
    await waitFor(() => expect(routeClient.cancelQueuedTurn).toHaveBeenCalledWith(
      running.chat.id,
      second.id,
      expect.objectContaining({ baseRevision: running.chat.revision + 3 }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Steer First queued turn" }));
    expect(within(queuePanel).getByText("First queued turn")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Steering First queued turn" })).toBeTruthy();
    expect(within(screen.getByRole("log")).queryByText("First queued turn")).toBeNull();
    expect(routeClient.steerQueuedTurn).toHaveBeenCalledTimes(1);
    finishSteer(steered);
    await waitFor(() => expect(routeClient.steerQueuedTurn).toHaveBeenCalledWith(
      running.chat.id,
      activeRunRecord.id,
      first.id,
      expect.objectContaining({ expectedTurnId: activeRunRecord.turnId }),
    ));
    await waitFor(() => expect(within(queuePanel).queryByText("First queued turn")).toBeNull());
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("First queued turn")).toBeTruthy());
  });

  it("keeps Steer visible for a queued turn when no steerable Run is currently loaded", async () => {
    const queuedTurn = {
      id: "qturn_workspace_waiting",
      chatId: snapshot.chat.id,
      clientRequestId: "req_qturn_workspace_waiting",
      position: 1,
      parts: [{ type: "text" as const, text: "Waiting queued turn" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project" as const, projectId: "matrix-os" },
      createdAt: "2026-08-31T02:00:00.000Z",
      updatedAt: "2026-08-31T02:00:00.000Z",
    };
    const routeClient = client();
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
      queuedTurns: [queuedTurn],
    });

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const steer = await screen.findByRole("button", { name: "Steer Waiting queued turn" });
    expect((steer as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves an edited queued turn even after its active Run has ended", async () => {
    const queuedTurn = {
      id: "qturn_workspace_edit_after_run",
      chatId: snapshot.chat.id,
      clientRequestId: "req_qturn_workspace_edit_after_run",
      position: 1,
      parts: [{ type: "text" as const, text: "Original queued turn" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project" as const, projectId: "matrix-os" },
      createdAt: "2026-08-31T02:00:00.000Z",
      updatedAt: "2026-08-31T02:00:00.000Z",
    };
    const routeClient = client();
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
      queuedTurns: [queuedTurn],
    });
    vi.mocked(routeClient.updateQueuedTurn).mockResolvedValue({
      queuedTurn: {
        ...queuedTurn,
        parts: [{ type: "text", text: "Edited after Run" }],
      },
    });

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Original queued turn" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Original queued turn" }));
    await setSharedComposerText(editor, "Edited after Run");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(routeClient.updateQueuedTurn).toHaveBeenCalledWith(
      snapshot.chat.id,
      queuedTurn.id,
      expect.objectContaining({ parts: [{ type: "text", text: "Edited after Run" }] }),
    ));
    expect(routeClient.admitTurn).not.toHaveBeenCalled();
  });

  it("leaves queued-edit mode when a failed save reloads a Queue that no longer contains the turn", async () => {
    const queuedTurn = {
      id: "qturn_workspace_removed_during_edit",
      chatId: snapshot.chat.id,
      clientRequestId: "req_qturn_workspace_removed_during_edit",
      position: 1,
      parts: [{ type: "text" as const, text: "Original queued turn" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project" as const, projectId: "matrix-os" },
      createdAt: "2026-08-31T02:00:00.000Z",
      updatedAt: "2026-08-31T02:00:00.000Z",
    };
    const routeClient = client();
    vi.mocked(routeClient.getDetail)
      .mockResolvedValueOnce({
        record,
        messages: snapshot.messages,
        turns: snapshot.turns,
        runs: snapshot.runs,
        activities: snapshot.activities,
        queuedTurns: [queuedTurn],
      })
      .mockResolvedValue({
        record,
        messages: snapshot.messages,
        turns: snapshot.turns,
        runs: snapshot.runs,
        activities: snapshot.activities,
        queuedTurns: [],
      });
    vi.mocked(routeClient.updateQueuedTurn).mockRejectedValue(new Error("QueueRevisionConflict"));

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Original queued turn" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Original queued turn" }));
    await setSharedComposerText(editor, "Keep this text as a normal draft");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Queued turns" })).toBeNull());
    await waitFor(() => expect(
      screen.getByRole("textbox", { name: "Reply to chat" }).getAttribute("aria-placeholder"),
    ).toBe("Reply to chat…"));
    const reloadedEditor = screen.getByRole("textbox", { name: "Reply to chat" });
    expect(reloadedEditor.textContent).toContain("Keep this text as a normal draft");
  });

  it("leaves queued-edit mode when the user starts a new Chat", async () => {
    const queuedTurn = {
      id: "qturn_workspace_edit_then_new",
      chatId: snapshot.chat.id,
      clientRequestId: "req_qturn_workspace_edit_then_new",
      position: 1,
      parts: [{ type: "text" as const, text: "Edit before new Chat" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project" as const, projectId: "matrix-os" },
      createdAt: "2026-08-31T02:00:00.000Z",
      updatedAt: "2026-08-31T02:00:00.000Z",
    };
    const routeClient = client();
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
      queuedTurns: [queuedTurn],
    });

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId={null}
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Edit before new Chat" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Edit before new Chat" }));
    expect(editor.getAttribute("aria-placeholder")).toBe("Edit queued message…");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    const newChatEditor = await screen.findByRole("textbox", { name: "Start a chat" });
    expect(newChatEditor.getAttribute("aria-placeholder")).toBe("How can I help you today?");
  });
  it("uses the file capability to attach, preview, retry, remove, and submit multiple files", async () => {
    const instanceId = "openclaw_file_capable";
    const fileCatalog: CanonicalProviderCatalog = {
      ...providerCatalog,
      drivers: [{
        ...providerCatalog.drivers[0]!,
        kind: "openclaw",
        displayName: "OpenClaw",
        capabilityClass: "system_agent",
      }],
      instances: [{
        ...providerCatalog.instances[0]!,
        id: instanceId,
        driverKind: "openclaw",
        displayName: "OpenClaw",
        supports: { ...providerCatalog.instances[0]!.supports, attachments: ["file"] },
        defaultSelection: { instanceId, model: providerCatalog.instances[0]!.models[0]!.id },
      }],
    };
    const fileRecord = {
      ...record,
      chat: {
        ...record.chat,
        currentSelection: { instanceId, model: providerCatalog.instances[0]!.models[0]!.id },
      },
      providerBinding: {
        ...record.providerBinding,
        driverKind: "openclaw" as const,
        instanceId,
      },
    };
    let retryFailed = false;
    const api = {
      baseUrl: "https://matrix.test",
      get: vi.fn(),
      getText: vi.fn(),
      getBlob: vi.fn(),
      post: vi.fn(),
      postBytes: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      putBytes: vi.fn(async (url: string, file: File) => {
        if (file.name === "retry.txt" && !retryFailed) {
          retryFailed = true;
          throw new Error("temporary upload failure");
        }
        return {
          ok: true,
          path: decodeURIComponent(url.split("path=")[1] ?? ""),
          size: file.size,
        };
      }),
      delete: vi.fn(),
      putText: vi.fn(),
    } as never;
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [fileRecord] });
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: fileRecord,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });
    vi.mocked(routeClient.admitTurn).mockResolvedValue({
      record: fileRecord,
      message: { ...snapshot.messages[0]!, id: "msg_attachment", turnId: "turn_attachment" },
      turn: {
        ...snapshot.turns[0]!,
        id: "turn_attachment",
        inputMessageId: "msg_attachment",
        clientRequestId: "req_attachment",
      },
      run: { ...snapshot.runs[0]!, id: "run_attachment", turnId: "turn_attachment" },
      admission: "accepted",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render(
      <CanonicalChatWorkspace
        api={api}
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={fileCatalog}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    const input = screen.getByLabelText("Choose files") as HTMLInputElement;
    const inputClick = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(inputClick).toHaveBeenCalledOnce();
    expect(input.multiple).toBe(true);
    const contextButton = screen.getByRole("button", { name: "Project Matrix OS" });
    expect(contextButton).toBeTruthy();
    expect(contextButton.querySelector('[data-slot="attachment-paperclip-icon"]')).toBeNull();

    const keep = new File(["keep"], "keep.txt", { type: "text/plain" });
    const remove = new File(["remove"], "remove.txt", { type: "text/plain" });
    const retry = new File(["retry"], "retry.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [keep, remove, retry] } });

    expect(screen.getByRole("group", { name: "Attachments" })).toBeTruthy();
    expect(screen.getByText("keep.txt")).toBeTruthy();
    expect(screen.getByText("remove.txt")).toBeTruthy();
    expect(screen.getByText("retry.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove remove.txt" }));
    expect(screen.queryByText("remove.txt")).toBeNull();

    await setSharedComposerText(editor, "Inspect these files");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const retryButton = await screen.findByRole("button", { name: "Retry retry.txt" });
    expect(routeClient.admitTurn).not.toHaveBeenCalled();

    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry retry.txt" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(routeClient.admitTurn).toHaveBeenCalledOnce());
    const request = vi.mocked(routeClient.admitTurn).mock.calls[0]![1];
    expect(request.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Inspect these files" }),
      expect.objectContaining({ type: "attachment_reference", kind: "file", label: "keep.txt" }),
      expect.objectContaining({ type: "attachment_reference", kind: "file", label: "retry.txt" }),
    ]));
    expect(request.parts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "remove.txt" }),
      expect.objectContaining({ type: "resource_reference" }),
    ]));
    warn.mockRestore();
  });

});
