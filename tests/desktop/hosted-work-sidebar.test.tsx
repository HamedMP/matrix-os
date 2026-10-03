// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { StartAgentChat } from "@matrix-os/ui";
import { HostedWorkSidebar } from "@desktop/renderer/src/features/work/HostedWorkSidebar";
import { WorkSurfaceRuntimeProvider, useWorkSurfaceRuntime } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
import type { CanonicalChatTitleProjection } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import type { Project } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";
import { appendSharedComposerText } from "./shared-chat-composer-test-utils";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renamedRecord: CanonicalChatRecord = {
  chat: {
    id: "chat_global",
    ownerScope: { type: "personal", ownerId: "owner_test" },
    title: "Synced title",
    lifecycle: "active",
    attention: "none",
    revision: 2,
    messageCount: 1,
    userState: { readThroughSeq: 0, pinned: false, muted: false },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T01:00:00.000Z",
  },
};
const secondRenamedRecord: CanonicalChatRecord = {
  ...renamedRecord,
  chat: { ...renamedRecord.chat, id: "chat_second", title: "Second synced title" },
};
const draftCallbacks = vi.hoisted(() => ({ starts: [] as StartAgentChat[], newChats: [] as Array<() => void> }));

vi.mock("@desktop/renderer/src/features/work/WorkRail", () => ({
  WorkRail: (props: {
    onChatRenamed?: (record: CanonicalChatRecord) => void;
    projectedChatTitles?: CanonicalChatTitleProjection[];
    onStartAgentChat?: StartAgentChat;
    onOpenBotChat?: (chatId: string) => void;
    onNewGlobalChat?: () => void;
    onSelectProject?: (project: Project) => void;
    onNewProjectChat?: (project: Project) => void;
  }) => {
    if (props.onStartAgentChat) draftCallbacks.starts.push(props.onStartAgentChat);
    if (props.onNewGlobalChat) draftCallbacks.newChats.push(props.onNewGlobalChat);
    return (<>
    <button onClick={() => props.onNewGlobalChat?.()}>New chat</button>
    <button onClick={() => props.onSelectProject?.({ id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" })}>Open Alpha</button>
    <button onClick={() => props.onNewProjectChat?.({ id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" })}>New chat in Alpha</button>
    <button onClick={() => props.onOpenBotChat?.("chat_bound_bot")}>Open recipe bot</button>
    <button onClick={() => props.onStartAgentChat?.("", [{ kind: "agent", id: "bot_review", label: "Review agent", revision: "3" }])}>Start saved agent</button>
    <button onClick={() => props.onStartAgentChat?.("Create a research agent")}>Start recipe draft</button>
    <button type="button" onClick={() => props.onChatRenamed?.(renamedRecord)}>
      Complete hosted rail rename
    </button>
    <span data-testid="hosted-rail-projected-title">
      {props.projectedChatTitles?.map((projection) => projection.title).join("|") || "No projection"}
    </span>
  </>);
  },
}));

function ProjectHeaderRename() {
  const runtime = useWorkSurfaceRuntime();
  return <>
    <button type="button" onClick={() => runtime?.projectChat(renamedRecord)}>Complete header rename</button>
    <button type="button" onClick={() => runtime?.projectChat(secondRenamedRecord)}>Complete second header rename</button>
  </>;
}

function HostedDraftReceipt() {
  const runtime = useWorkSurfaceRuntime();
  return <output data-testid="hosted-agent-draft">{JSON.stringify(runtime?.agentDraftRequest ?? null)}</output>;
}

function HostedComposer({ client }: { client: ReturnType<typeof createCanonicalChatWorkspaceClient> }) {
  const runtime = useWorkSurfaceRuntime();
  return <CanonicalChatWorkspace client={client} catalog={providerCatalog} projectId={null}
    initialView="draft" draftRequest={runtime?.agentDraftRequest} externalNavigation active />;
}

beforeEach(() => {
  draftCallbacks.starts = [];
  draftCallbacks.newChats = [];
  useConnection.setState(useConnection.getInitialState(), true);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  useTabs.setState(useTabs.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HostedWorkSidebar", () => {
  it.each(["chat_bound_bot", "chat_existing", undefined])("opens an ordinary Project draft from %s without creating a server Chat", (chatId) => {
    useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatId, chatView: chatId ? "conversation" : "draft", closable: false });
    const tab = useTabs.getState().tabs[0]!;
    render(<WorkSurfaceRuntimeProvider active={false}><HostedWorkSidebar tab={tab} active /><HostedDraftReceipt /></WorkSurfaceRuntimeProvider>);
    const focusRequest = useCodingAgentWorkspace.getState().composerFocusRequestId;
    fireEvent.click(screen.getByRole("button", { name: "New chat in Alpha" }));
    expect(useTabs.getState().tabs[0]).toMatchObject({ workRoute: "project", projectSlug: "alpha", chatView: "draft", chatId: undefined });
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequest + 1);
    expect(screen.getByTestId("hosted-agent-draft").textContent).toBe("null");
    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(useTabs.getState().tabs[0]?.chatView).toBe("index");
  });

  it("requests bot event wire v1 for the hosted Electron Chat stream", async () => {
    const openStream = vi.fn(() => new Promise<Response>(() => {}));
    useConnection.setState({ api: { openStream } as never });
    render(<WorkSurfaceRuntimeProvider active><HostedDraftReceipt /></WorkSurfaceRuntimeProvider>);
    await waitFor(() => expect(openStream).toHaveBeenCalled());
    expect(openStream.mock.calls[0]![0]).toContain("eventVersion=1");
  });
  it("replaces an already-open draft on every outer New chat click", async () => {
    useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false });
    const tab = useTabs.getState().tabs[0]!;
    const client = createCanonicalChatWorkspaceClient();
    render(<WorkSurfaceRuntimeProvider active={false}>
      <HostedWorkSidebar tab={tab} active /><HostedComposer client={client} /><HostedDraftReceipt />
    </WorkSurfaceRuntimeProvider>);
    const composer = await screen.findByRole("textbox");
    await appendSharedComposerText(composer, "Abandoned draft");
    await waitFor(() => expect(composer.textContent).toBe("Abandoned draft"));
    fireEvent.click(screen.getByRole("button", { name: "New chat", exact: true }));
    await waitFor(() => expect(composer.textContent).toBe(""));
    const firstRequest = JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!);
    await appendSharedComposerText(composer, "Second abandoned draft");
    fireEvent.click(screen.getByRole("button", { name: "New chat", exact: true }));
    await waitFor(() => expect(composer.textContent).toBe(""));
    expect(JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!).id).not.toBe(firstRequest.id);
    fireEvent.click(screen.getByRole("button", { name: "Start recipe draft" }));
    await waitFor(() => expect(composer.textContent).toBe("Create a research agent"));
    fireEvent.click(screen.getByRole("button", { name: "New chat", exact: true }));
    await waitFor(() => expect(composer.textContent).toBe(""));
    expect(client.create).not.toHaveBeenCalled();
    expect(client.admitTurn).not.toHaveBeenCalled();
  });

  it("hands a saved Agent and a later recipe draft to the hosted Chat without sending", () => {
    useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatId: "chat_old", chatView: "conversation", closable: false });
    const tab = useTabs.getState().tabs[0]!;
    render(<WorkSurfaceRuntimeProvider active={false}><HostedWorkSidebar tab={tab} active /><HostedDraftReceipt /></WorkSurfaceRuntimeProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Start saved agent" }));
    expect(useTabs.getState().tabs[0]).toMatchObject({ chatView: "draft", chatId: undefined });
    expect(JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!)).toMatchObject({
      text: "", resources: [{ kind: "agent", id: "bot_review", label: "Review agent", revision: "3" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recipe draft" }));
    expect(JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!)).toMatchObject({ text: "Create a research agent" });
    expect(JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!).resources).toBeUndefined();
  });
  it("preserves an identity-bound draft when the API client becomes available, and clears changed credentials",()=>{
    render(<WorkSurfaceRuntimeProvider active={false}><HostedDraftReceipt/><HostedWorkSidebar tab={{id:"work_draft",kind:"work",title:"Chat",workRoute:"chat",chatView:"draft",closable:false}} active/></WorkSurfaceRuntimeProvider>);
    fireEvent.click(screen.getByRole("button",{name:"Start saved agent"}));
    const request=JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!);
    expect(request.resources).toHaveLength(1);
    act(()=>useConnection.setState({api:{} as never}));
    expect(JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!)).toEqual(request);
    act(()=>useConnection.setState({authGeneration:1}));
    expect(screen.getByTestId("hosted-agent-draft").textContent).toBe("null");
  });
  it("does not navigate the current runtime from retained old Agent or New chat callbacks", () => {
    render(<WorkSurfaceRuntimeProvider active={false}><HostedDraftReceipt /><HostedWorkSidebar
      tab={{ id: "work", kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false }} active />
    </WorkSurfaceRuntimeProvider>);
    const oldStart = draftCallbacks.starts.at(-1)!;
    const oldNewChat = draftCallbacks.newChats.at(-1)!;
    act(() => useConnection.setState({ authGeneration: 1, runtimeSlot: "preview" }));
    act(() => useTabs.getState().openTab({ kind: "work", title: "Current chat", workRoute: "chat", chatId: "chat_current", chatView: "conversation", closable: false }));
    const tabs = useTabs.getState().tabs;
    act(() => oldStart("Late result"));
    expect(useTabs.getState().tabs).toBe(tabs);
    act(() => oldNewChat());
    expect(useTabs.getState().tabs).toBe(tabs);
    expect(screen.getByTestId("hosted-agent-draft").textContent).toBe("null");
  });
  it("opens a recipe bot's bound conversation instead of an Agent draft", () => {
    useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false });
    const tab = useTabs.getState().tabs[0]!;
    render(<WorkSurfaceRuntimeProvider active={false}><HostedWorkSidebar tab={tab} active /><HostedDraftReceipt /></WorkSurfaceRuntimeProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open recipe bot" }));
    expect(useTabs.getState().tabs[0]).toMatchObject({
      workRoute: "chat", chatId: "chat_bound_bot", chatView: "conversation",
    });
    expect(screen.getByTestId("hosted-agent-draft").textContent).toBe("null");
    fireEvent.click(screen.getByRole("button", { name: "Start saved agent" }));
    expect(useTabs.getState().tabs[0]).toMatchObject({ chatView: "draft", chatId: undefined });
    expect(JSON.parse(screen.getByTestId("hosted-agent-draft").textContent!)).toMatchObject({
      resources: [{ kind: "agent", id: "bot_review", label: "Review agent", revision: "3" }],
    });
  });

  it("synchronizes a rail rename into the active center-title projection", () => {
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatId: "chat_global",
      chatTitle: "Old title",
      chatView: "conversation",
      closable: false,
    });
    const tab = useTabs.getState().tabs[0]!;

    render(<HostedWorkSidebar tab={tab} active />);
    fireEvent.click(screen.getByRole("button", { name: "Complete hosted rail rename" }));

    expect(useTabs.getState().tabs[0]?.chatTitle).toBe("Synced title");
  });

  it("synchronizes a header rename directly into the mounted hosted rail without a stream event", () => {
    useTabs.getState().openTab({
      kind: "work", title: "Chat", workRoute: "chat", chatId: "chat_global",
      chatTitle: "Old title", chatView: "conversation", closable: false,
    });
    const tab = useTabs.getState().tabs[0]!;

    render(
      <WorkSurfaceRuntimeProvider active={false}>
        <ProjectHeaderRename />
        <HostedWorkSidebar tab={tab} active={false} />
      </WorkSurfaceRuntimeProvider>,
    );
    expect(screen.getByTestId("hosted-rail-projected-title").textContent).toBe("No projection");
    fireEvent.click(screen.getByRole("button", { name: "Complete header rename" }));
    expect(screen.getByTestId("hosted-rail-projected-title").textContent).toBe("Synced title");
  });

  it("retains bounded projections for multiple header renames", () => {
    useTabs.getState().openTab({
      kind: "work", title: "Chat", workRoute: "chat", chatId: "chat_global",
      chatTitle: "Old title", chatView: "conversation", closable: false,
    });
    const tab = useTabs.getState().tabs[0]!;

    render(
      <WorkSurfaceRuntimeProvider active={false}>
        <ProjectHeaderRename />
        <HostedWorkSidebar tab={tab} active={false} />
      </WorkSurfaceRuntimeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete header rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete second header rename" }));

    expect(screen.getByTestId("hosted-rail-projected-title").textContent)
      .toBe("Synced title|Second synced title");
  });
});
