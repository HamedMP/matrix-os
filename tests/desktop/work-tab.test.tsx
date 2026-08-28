// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import WorkTab from "@desktop/renderer/src/features/work/WorkTab";
import { SurfaceChromeContext, type SurfaceChromeSpec } from "@desktop/renderer/src/features/desktop-shell/SurfaceChrome";
import { useBoard, type Project } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "@desktop/renderer/src/lib/hugeicons";
import { expectRenderedIcon } from "../helpers/rendered-icon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inspectorProps = vi.hoisted(() => ({
  active: [] as boolean[],
}));
const chatTabProps = vi.hoisted(() => ({
  tabIds: [] as Array<string | undefined>,
}));

vi.mock("@desktop/renderer/src/features/chat/ChatTab", () => ({
  default: ({
    tabId,
    renderInspector,
    inspectorExclusive,
  }: {
    tabId?: string;
    renderInspector?: (detail: unknown) => React.ReactNode;
    inspectorExclusive?: boolean;
  }) => {
    chatTabProps.tabIds.push(tabId);
    return (
      <>
        <main aria-hidden={inspectorExclusive || undefined}>Chat center</main>
        {renderInspector?.({ record: { chat: { id: "chat_global" } }, activities: [] })}
      </>
    );
  },
}));
vi.mock("@desktop/renderer/src/features/project/ProjectChatsView", () => ({
  default: ({
    renderInspector,
    inspectorExclusive,
  }: {
    renderInspector?: (detail: unknown) => React.ReactNode;
    inspectorExclusive?: boolean;
  }) => (
    <>
      <main aria-hidden={inspectorExclusive || undefined}>Project center</main>
      {renderInspector?.({ record: { chat: { id: "chat_alpha" } }, activities: [] })}
    </>
  ),
}));
vi.mock("@desktop/renderer/src/features/project/ProjectsIndex", () => ({
  default: () => <main>Projects center</main>,
}));
vi.mock("@desktop/renderer/src/features/work/WorkFilesInspector", () => ({
  WorkFilesInspector: ({
    active,
    onClose,
    closeLabel,
    closeButtonRef,
    resolveDraftChatId,
    onDraftTerminalCreated,
  }: {
    active: boolean;
    onClose?: () => void;
    closeLabel?: string;
    closeButtonRef?: React.Ref<HTMLButtonElement>;
    resolveDraftChatId?: () => Promise<string | null>;
    onDraftTerminalCreated?: (chatId: string, session: { id: string; name: string; status: "running"; attachable: true; createdAt: string; updatedAt: string }) => void;
  }) => {
    inspectorProps.active.push(active);
    return (
      <aside aria-label="Chat inspector" data-active={String(active)}>
        <button type="button">Inspector action</button>
        {resolveDraftChatId && onDraftTerminalCreated ? (
          <button type="button" onClick={() => {
            void resolveDraftChatId().then((chatId) => {
              if (!chatId) return;
              onDraftTerminalCreated(chatId, {
                id: "chat-draft-terminal",
                name: "chat-draft-terminal",
                status: "running",
                attachable: true,
                createdAt: "2026-08-28T10:00:00.000Z",
                updatedAt: "2026-08-28T10:00:00.000Z",
              });
            });
          }}>Create draft terminal</button>
        ) : null}
        {onClose ? (
          <button ref={closeButtonRef} type="button" aria-label={closeLabel} aria-expanded="true" onClick={onClose}>Close</button>
        ) : null}
      </aside>
    );
  },
}));

const resizeObserverCallbacks: ResizeObserverCallback[] = [];
let initialWorkWidth = 1_400;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

class WorkResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

function resizeWork(width: number) {
  initialWorkWidth = width;
  const callback = resizeObserverCallbacks.at(-1);
  if (!callback) throw new Error("Work ResizeObserver was not registered");
  const entry = { contentRect: { width } } as unknown as ResizeObserverEntry;
  act(() => callback([entry], {} as ResizeObserver));
}

const alpha: Project = {
  id: "project_alpha_id",
  slug: "alpha",
  name: "Alpha",
  kind: "folder",
};

function chat(id: string, title: string, projectId?: string): CanonicalChatRecord {
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "owner_test" },
      title,
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      userState: { readThroughSeq: 0, pinned: false, muted: false },
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
    },
    ...(projectId ? { projectId } : {}),
  };
}

const globalChat = chat("chat_global", "Global chat");
const projectChat = chat("chat_alpha", "Alpha chat", "project_alpha_id");

function activeWorkTab() {
  return useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId);
}

describe("WorkTab rail integration", () => {
  beforeEach(() => {
    resizeObserverCallbacks.length = 0;
    inspectorProps.active = [];
    chatTabProps.tabIds = [];
    initialWorkWidth = 1_400;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => initialWorkWidth,
    });
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 800,
      right: initialWorkWidth,
      width: initialWorkWidth,
      height: 800,
      toJSON: () => ({}),
    });
    globalThis.ResizeObserver = WorkResizeObserver;
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/api/chats")) return { items: [projectChat, globalChat] };
      throw new Error("Unexpected WorkTab test request");
    });
    useConnection.setState({
      ...useConnection.getInitialState(),
      status: "signed-in",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: {
        baseUrl: "https://matrix.test",
        get,
        post: vi.fn(async (path: string) => {
          if (path === "/api/chats") return chat("chat_draft_terminal", "New chat");
          throw new Error("Unexpected WorkTab test request");
        }),
        patch: vi.fn(),
        delete: vi.fn(),
      } as never,
    }, true);
    useBoard.setState({ ...useBoard.getInitialState(), projects: [alpha] }, true);
    useProjectView.setState(useProjectView.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it("forwards the owning top-level tab id to the Global Chat route", () => {
    render(<WorkTab tabId="chat-tab-2" route="chat" active />);

    expect(chatTabProps.tabIds).toContain("chat-tab-2");
  });

  it("opens a Global draft and the existing Create Project dialog state", async () => {
    useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "projects", closable: false });
    render(<WorkTab route="projects" active />);
    await screen.findByRole("button", { name: "Global chat" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(activeWorkTab()).toMatchObject({
      kind: "work",
      workRoute: "chat",
      chatView: "draft",
      chatId: undefined,
      projectSlug: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(useUi.getState().createProjectOpen).toBe(true);
  });

  it("clears the old Chat for Project compose and does not expose Board", async () => {
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "project",
      projectSlug: "alpha",
      chatId: "chat_alpha",
      chatView: "conversation",
      closable: false,
    });
    render(
      <WorkTab
        route="project"
        projectSlug="alpha"
        active
        initialChatId="chat_alpha"
        initialChatView="conversation"
      />,
    );
    await screen.findByRole("button", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));

    fireEvent.click(screen.getByRole("button", { name: "New chat in Alpha" }));
    expect(activeWorkTab()).toMatchObject({
      kind: "work",
      workRoute: "project",
      projectSlug: "alpha",
      chatId: undefined,
      chatView: "draft",
    });
    expect(useProjectView.getState().viewFor("alpha")).toBe("chats");

    expect(screen.queryByRole("button", { name: "Open Alpha board" })).toBeNull();
    expect(useProjectView.getState().viewFor("alpha")).toBe("chats");
  });

  it("selects Global and Project Chats in the retained Work route", async () => {
    useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "projects", closable: false });
    render(<WorkTab route="projects" active />);
    await screen.findByRole("button", { name: "Global chat" });

    fireEvent.click(screen.getByRole("button", { name: "Global chat" }));
    expect(activeWorkTab()).toMatchObject({
      kind: "work",
      workRoute: "chat",
      chatId: "chat_global",
      chatView: "conversation",
      projectSlug: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha chat" }));
    expect(activeWorkTab()).toMatchObject({
      kind: "work",
      workRoute: "project",
      projectSlug: "alpha",
      chatId: "chat_alpha",
      chatView: "conversation",
    });
    expect(useProjectView.getState().viewFor("alpha")).toBe("chats");
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it("returns the retained Work route to a draft after deleting its active Chat", async () => {
    initialWorkWidth = 900;
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatId: "chat_global",
      chatView: "conversation",
      closable: false,
    });
    const view = render(
      <WorkTab
        route="chat"
        active
        initialChatId="chat_global"
        initialChatView="conversation"
      />,
    );
    await screen.findByRole("button", { name: "Global chat" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Global chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    await waitFor(() => expect(activeWorkTab()).toMatchObject({
      kind: "work",
      workRoute: "chat",
      chatView: "draft",
      chatId: undefined,
    }));
    view.rerender(<WorkTab route="chat" active initialChatView="draft" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy());
    expect(screen.getByRole("navigation", { name: "Chat navigation" })).toBeTruthy();
  });

  it("collapses the medium inspector behind an accessible control and restores focus", async () => {
    render(
      <WorkTab
        route="chat"
        active
        initialChatId="chat_global"
        initialChatView="conversation"
      />,
    );
    await screen.findByRole("button", { name: "Global chat" });

    resizeWork(900);

    const showTools = screen.getByRole("button", { name: "Show inspector" });
    expect(showTools.getAttribute("aria-expanded")).toBe("false");
    expect(showTools.getAttribute("aria-controls")).toBe("work-inspector");
    expect(screen.queryByRole("complementary", { name: "Chat inspector" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Chat inspector", hidden: true }).getAttribute("data-active")).toBe("false");

    fireEvent.click(showTools);

    const hideTools = screen.getByRole("button", { name: "Hide inspector" });
    expect(document.activeElement).toBe(hideTools);
    expect(screen.queryByRole("button", { name: "Close inspector" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Chat inspector" }).getAttribute("data-active")).toBe("true");
    expect(screen.queryByRole("button", { name: "Dismiss inspector" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Chat navigation" })).toBeNull();

    fireEvent.click(hideTools);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show inspector" })));
    expect(inspectorProps.active.at(-1)).toBe(false);
  });

  it.each([
    ["draft", { route: "chat" as const, initialChatId: undefined, initialChatView: "draft" as const }, true],
    ["index", { route: "chat" as const, initialChatId: undefined, initialChatView: "index" as const }, true],
    ["Projects", { route: "projects" as const, initialChatId: undefined, initialChatView: undefined }, false],
  ])("returns a stale narrow inspector to Chat when rerendered as %s", async (_name, nextProps, inspectorRemainsMounted) => {
    const view = render(
      <WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />,
    );
    await screen.findByRole("button", { name: "Global chat" });
    resizeWork(640);
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(screen.getByRole("main", { hidden: true }).getAttribute("aria-hidden")).toBe("true");

    view.rerender(<WorkTab {...nextProps} active />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("main").getAttribute("aria-hidden")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Chat inspector" })).toBeNull();
    if (inspectorRemainsMounted) expect(inspectorProps.active.at(-1)).toBe(false);
  });

  it("keeps the Project on canonical Chat even when a legacy Board preference is restored", async () => {
    useProjectView.getState().setView("alpha", "board");
    render(
      <WorkTab route="project" projectSlug="alpha" active initialChatId="chat_alpha" initialChatView="conversation" />,
    );
    await screen.findByRole("button", { name: "Alpha" });
    expect(screen.getByText("Project center")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Board" })).toBeNull();
    expect(useProjectView.getState().viewFor("alpha")).toBe("chats");
  });

  it("resizes both sidebars with keyboard-accessible separators", async () => {
    render(<WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />);
    await screen.findByRole("button", { name: "Global chat" });

    const navigationSeparator = screen.getByRole("separator", { name: "Resize Chat navigation" });
    const inspectorSeparator = screen.getByRole("separator", { name: "Resize Chat inspector" });
    expect(navigationSeparator.getAttribute("aria-valuenow")).toBe("260");
    expect(inspectorSeparator.getAttribute("aria-valuenow")).toBe("640");
    expect(navigationSeparator.querySelector("span")?.style.background).toBe("var(--border-subtle)");
    expect(inspectorSeparator.querySelector("span")?.style.background).toBe("transparent");

    fireEvent.keyDown(navigationSeparator, { key: "ArrowRight" });
    fireEvent.keyDown(inspectorSeparator, { key: "ArrowLeft" });

    expect(screen.getByRole("separator", { name: "Resize Chat navigation" }).getAttribute("aria-valuenow")).toBe("276");
    expect(screen.getByRole("separator", { name: "Resize Chat inspector" }).getAttribute("aria-valuenow")).toBe("656");
  });

  it("collapses both sidebars when their dividers move past the minimum", async () => {
    render(<WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />);
    await screen.findByRole("button", { name: "Global chat" });

    const navigationSeparator = screen.getByRole("separator", { name: "Resize Chat navigation" });
    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(navigationSeparator, { key: "ArrowLeft" });
    expect(screen.queryByRole("navigation", { name: "Chat navigation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show Chat navigation" })).toBeTruthy();

    const inspectorSeparator = screen.getByRole("separator", { name: "Resize Chat inspector" });
    for (let step = 0; step < 12; step += 1) fireEvent.keyDown(inspectorSeparator, { key: "ArrowRight" });
    expect(screen.queryByRole("complementary", { name: "Chat inspector" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
  });

  it("makes the Files inspector available on a new Global Chat draft", async () => {
    render(<WorkTab route="chat" active initialChatView="draft" />);
    await screen.findByRole("button", { name: "Global chat" });

    expect(screen.getByRole("complementary", { name: "Chat inspector" })).toBeTruthy();
  });

  it("creates and selects a canonical Chat before starting a Terminal from New Chat", async () => {
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatView: "draft",
      closable: false,
    });
    render(<WorkTab route="chat" active initialChatView="draft" />);
    await screen.findByRole("button", { name: "Create draft terminal" });

    fireEvent.click(screen.getByRole("button", { name: "Create draft terminal" }));

    await waitFor(() => expect(useConnection.getState().api?.post).toHaveBeenCalledWith(
      "/api/chats",
      expect.objectContaining({ title: "New chat", clientRequestId: expect.stringMatching(/^req_/) }),
    ));
    await waitFor(() => expect(activeWorkTab()).toMatchObject({
      kind: "work",
      workRoute: "chat",
      chatId: "chat_draft_terminal",
      chatView: "draft",
    }));
  });

  it("opens a new Chat directly into its inspector at medium width without overlap", async () => {
    initialWorkWidth = 900;
    render(<WorkTab route="chat" active initialChatView="draft" />);
    await screen.findByText("Chat center");

    expect(screen.getByRole("complementary", { name: "Chat inspector" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Chat navigation" })).toBeNull();
  });

  it("preserves closed inspector and visible navigation when an existing medium Work surface switches to New Chat", async () => {
    initialWorkWidth = 900;
    const view = render(<WorkTab route="projects" active />);
    await screen.findByRole("button", { name: "Global chat" });

    view.rerender(<WorkTab route="chat" active initialChatView="draft" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy());
    expect(screen.getByRole("navigation", { name: "Chat navigation" })).toBeTruthy();
  });

  it("preserves a closed inspector when a medium Chat window is maximized", async () => {
    initialWorkWidth = 900;
    render(<WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />);
    await screen.findByRole("button", { name: "Show inspector" });

    resizeWork(1_400);

    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Chat navigation" })).toBeTruthy();
  });

  it("registers both pane toggles and the Chat title in the shared surface chrome", async () => {
    function HostedWork() {
      const [chrome, setChrome] = React.useState<SurfaceChromeSpec | null>(null);
      const host = React.useMemo(() => ({ setChrome }), []);
      return (
        <SurfaceChromeContext.Provider value={host}>
          <header>
            {chrome?.leftActions}
            <span>{chrome?.title}</span>
            {chrome?.rightActions}
            <output data-testid="left-pane-width">{chrome?.leftPaneWidth}</output>
            <output data-testid="right-pane-width">{chrome?.rightPaneWidth}</output>
          </header>
          <WorkTab
            route="chat"
            active
            initialChatId="chat_global"
            initialChatTitle="Global chat"
            initialChatView="conversation"
          />
        </SurfaceChromeContext.Provider>
      );
    }

    render(<HostedWork />);
    await screen.findByRole("button", { name: "Global chat" });

    expect(screen.getByText("Global chat", { selector: "header span" })).toBeTruthy();
    expect(screen.getByTestId("left-pane-width").textContent).toBe("260");
    expect(screen.getByTestId("right-pane-width").textContent).toBe("640");
    const hideNavigation = within(screen.getByRole("banner")).getByRole("button", { name: "Hide Chat navigation" });
    const hideInspector = screen.getByRole("button", { name: "Hide inspector" });
    expectRenderedIcon(hideNavigation.querySelector("svg"), PanelLeftOpenIcon);
    expect(hideNavigation.className).toContain("size-4");
    expect(hideNavigation.className).toContain("rounded-[4.8px]");
    expect(hideNavigation.querySelector("svg")?.getAttribute("width")).toBe("11.2");
    expect(hideInspector.className).toContain("size-4");
    expect(hideInspector.className).toContain("rounded-[4.8px]");
    expect(hideInspector.querySelector("svg")?.getAttribute("width")).toBe("11.2");
    expect(within(screen.getByRole("navigation", { name: "Chat navigation" })).queryByRole("button", { name: "Hide Chat navigation" })).toBeNull();
    expect(hideInspector).toBeTruthy();

    fireEvent.click(hideNavigation);
    expectRenderedIcon(screen.getByRole("button", { name: "Show Chat navigation" }).querySelector("svg"), PanelLeftCloseIcon);
    fireEvent.click(hideInspector);
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
  });

  it("omits a top-bar title for a new Chat draft", async () => {
    function HostedDraft() {
      const [chrome, setChrome] = React.useState<SurfaceChromeSpec | null>(null);
      const host = React.useMemo(() => ({ setChrome }), []);
      return (
        <SurfaceChromeContext.Provider value={host}>
          <header data-testid="draft-chrome">{chrome?.title}</header>
          <WorkTab route="chat" active initialChatView="draft" />
        </SurfaceChromeContext.Provider>
      );
    }

    render(<HostedDraft />);
    await screen.findByRole("button", { name: "Global chat" });

    expect(screen.getByTestId("draft-chrome").textContent).toBe("");
  });

  it("returns a stale narrow inspector to Chat when Work becomes inactive", async () => {
    const view = render(
      <WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />,
    );
    await screen.findByRole("button", { name: "Global chat" });
    resizeWork(640);
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));

    view.rerender(
      <WorkTab route="chat" active={false} initialChatId="chat_global" initialChatView="conversation" />,
    );

    expect(screen.getByRole("main").getAttribute("aria-hidden")).toBeNull();
    expect(inspectorProps.active.at(-1)).toBe(false);
  });

  it("moves focus into Chat after every narrow rail action that hides navigation", async () => {
    render(<WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />);
    await screen.findByRole("button", { name: "Global chat" });
    resizeWork(640);

    fireEvent.click(screen.getByRole("button", { name: "Show Chat navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Chat navigation" })));

    fireEvent.click(screen.getByRole("button", { name: "Show Chat navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat in Alpha" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Chat navigation" })));

    fireEvent.click(screen.getByRole("button", { name: "Show Chat navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Global chat" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Chat navigation" })));
  });

  it("returns to the middle Chat when an open inspector enters the narrow breakpoint", async () => {
    render(<WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />);
    await screen.findByRole("button", { name: "Global chat" });
    const inspectorAction = screen.getByRole("button", { name: "Inspector action" });
    inspectorAction.focus();

    resizeWork(900);
    expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("navigation", { name: "Chat navigation" })).toBeNull();
    expect(document.activeElement).toBe(inspectorAction);

    resizeWork(640);
    expect(screen.queryByRole("complementary", { name: "Chat inspector" })).toBeNull();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show inspector" }));

    resizeWork(900);
    expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
  });

  it.each([900, 0])("fails closed before the first ResizeObserver callback at %ipx", async (width) => {
    initialWorkWidth = width;
    render(<WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />);
    await screen.findByText("Chat center");

    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    expect(inspectorProps.active.every((value) => value === false)).toBe(true);
    expect(screen.queryByRole("complementary", { name: "Chat inspector" })).toBeNull();
  });

  it("dismisses the medium inspector with its stable toggle and Escape without an overlay backdrop", async () => {
    render(<WorkTab route="chat" active initialChatId="chat_global" initialChatView="conversation" />);
    await screen.findByRole("button", { name: "Global chat" });
    resizeWork(900);

    const showTools = screen.getByRole("button", { name: "Show inspector" });
    fireEvent.click(showTools);
    const hideTools = screen.getByRole("button", { name: "Hide inspector" });
    expect(hideTools.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hideTools);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show inspector" })));

    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show inspector" })));
    expect(inspectorProps.active.at(-1)).toBe(false);
  });

  it("shows one labeled pane at a time in narrow Work without losing the selected Chat", async () => {
    render(
      <WorkTab
        route="chat"
        active
        initialChatId="chat_global"
        initialChatView="conversation"
      />,
    );
    await screen.findByRole("button", { name: "Global chat" });

    resizeWork(640);

    expect(screen.getByText("Chat center")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Chat navigation" })).toBeNull();
    const showNavigation = screen.getByRole("button", { name: "Show Chat navigation" });
    expect(showNavigation.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(showNavigation);

    const backToChat = screen.getByRole("button", { name: "Back to chat" });
    expect(document.activeElement).toBe(backToChat);
    expect(screen.getByRole("navigation", { name: "Chat navigation" })).toBeTruthy();
    expect(screen.queryByRole("main")).toBeNull();

    fireEvent.click(backToChat);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Chat navigation" })));
    fireEvent.click(screen.getByRole("button", { name: "Show Chat navigation" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to chat" }));

    fireEvent.click(screen.getByRole("button", { name: "Global chat" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Chat navigation" })));
    expect(screen.getByText("Chat center")).toBeTruthy();
    expect(activeWorkTab()).toMatchObject({ chatId: "chat_global", chatView: "conversation" });

    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByRole("complementary", { name: "Chat inspector" }).getAttribute("data-active")).toBe("true");
    expect(screen.queryByRole("main")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show inspector" })));
    expect(screen.getByText("Chat center")).toBeTruthy();
    expect(inspectorProps.active.at(-1)).toBe(false);
  });
});
