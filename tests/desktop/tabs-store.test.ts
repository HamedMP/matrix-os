import { beforeEach, describe, expect, it } from "vitest";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
});

describe("tabs store", () => {
  it("clears pending terminal navigation when the runtime changes", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    useTabs.getState().requestTerminalSession("old-runtime-session");
    useTabs.getState().ensureNavigationScope("runtime-b");
    expect(useTabs.getState()).toMatchObject({
      navigationScope: "runtime-b", terminalSessionRequest: null, terminalSessionRequestSequence: 0,
    });
  });

  it("atomically closes every missing terminal tab and focuses the nearest retained tab", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const live = useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-live", title: "matrix-live" });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-missing", title: "matrix-missing" });
    useTabs.getState().openTab({
      kind: "terminal",
      sessionName: "matrix-also-missing",
      title: "matrix-also-missing",
    });
    useTabs.getState().requestTerminalSession("matrix-missing");

    useTabs.getState().reconcileTerminalSessions(["matrix-live"]);

    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home, live]);
    expect(useTabs.getState().activeTabId).toBe(live);
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
  });

  it("opens a tab and makes it active", () => {
    const id = useTabs.getState().openTab({ kind: "home", title: "Home" });
    const state = useTabs.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(id);
    expect(state.tabs[0]!.closable).toBe(true);
  });

  it("focuses an existing tab instead of duplicating by identity", () => {
    const a = useTabs.getState().openTab({ kind: "terminal", sessionName: "zellij-x", title: "zellij-x" });
    useTabs.getState().openTab({ kind: "home", title: "Home" });
    const again = useTabs.getState().openTab({ kind: "terminal", sessionName: "zellij-x", title: "zellij-x" });
    expect(again).toBe(a);
    expect(useTabs.getState().tabs.filter((t) => t.kind === "terminal")).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(a);
  });

  it("updates the requested Chat when focusing an existing route tab", () => {
    const tabId = useTabs.getState().openTab({ kind: "chat", title: "Chat", chatId: "chat_old" });

    const focusedId = useTabs.getState().openTab({ kind: "chat", title: "Chat", chatId: "chat_moved" });

    expect(focusedId).toBe(tabId);
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().tabs[0]?.chatId).toBe("chat_moved");
    expect(useTabs.getState().tabs[0]?.chatView).toBe("conversation");
  });

  it("keeps a Project Chat title for the shared Chat top row", () => {
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "project",
      projectSlug: "matrix-os",
      chatId: "chat_project",
      chatTitle: "Fix release pipeline",
    });

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "work",
      workRoute: "project",
      chatTitle: "Fix release pipeline",
    });
  });

  it("normalizes legacy Chat, Projects, and Project entries into one retained Work route", () => {
    const chat = useTabs.getState().openTab({
      kind: "chat",
      title: "Chat",
      chatId: "global-chat",
      closable: false,
    });
    const projects = useTabs.getState().openTab({
      kind: "projects",
      title: "Projects",
      closable: false,
    });
    const projectChat = useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
      chatId: "project-chat",
      closable: false,
    });
    expect(useTabs.getState().tabs[0]).toMatchObject({
      id: chat,
      kind: "work",
      workRoute: "project",
      projectSlug: "matrix-os",
      chatId: "project-chat",
    });
    const projectBoard = useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
      closable: false,
    });

    expect([chat, projects, projectChat, projectBoard]).toEqual([chat, chat, chat, chat]);
    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({
        id: chat,
        kind: "work",
        title: "Chat",
        workRoute: "project",
        projectSlug: "matrix-os",
        chatId: undefined,
      }),
    ]);
  });

  it("clears the selected canonical Chat when its root route is opened", () => {
    const tabId = useTabs.getState().openTab({
      kind: "chat",
      title: "Investigate streaming",
      chatId: "chat_selected",
      closable: false,
    });

    const focusedId = useTabs.getState().openTab({
      kind: "chat",
      title: "Chat",
      closable: false,
    });

    expect(focusedId).toBe(tabId);
    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "work", title: "Chat", workRoute: "chat" });
    expect(useTabs.getState().tabs[0]?.chatId).toBeUndefined();
    expect(useTabs.getState().tabs[0]?.chatView).toBe("index");
  });

  it("persists an explicit New Chat draft view across retained-tab focus changes", () => {
    const chatTabId = useTabs.getState().openTab({
      kind: "chat",
      title: "Chat",
      chatView: "draft",
      closable: false,
    });
    useTabs.getState().openTab({ kind: "home", title: "Home" });

    useTabs.getState().focusTab(chatTabId);

    expect(useTabs.getState().tabs.find((tab) => tab.id === chatTabId)?.chatView).toBe("draft");
  });

  it("preserves explicit top-level Chat instances when legacy Work routes normalize", () => {
    const workId = useTabs.getState().openTab({
      kind: "chat",
      title: "Chat",
      chatView: "draft",
      closable: false,
    });
    const independentChatId = useTabs.getState().openTabInstance({
      kind: "chat",
      title: "Chat",
      chatView: "draft",
      closable: true,
    });

    useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });

    expect(useTabs.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workId, kind: "work", workRoute: "chat", closable: false }),
      expect.objectContaining({ id: independentChatId, kind: "chat", chatView: "draft", closable: true }),
    ]));
  });

  it("treats distinct terminal identities as distinct tabs", () => {
    useTabs.getState().openTab({ kind: "terminal", sessionName: "a", title: "A" });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "b", title: "B" });
    expect(useTabs.getState().tabs).toHaveLength(2);
  });

  it("respects closable:false", () => {
    const id = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    expect(useTabs.getState().tabs.find((t) => t.id === id)!.closable).toBe(false);
  });

  it("does not close a non-closable tab", () => {
    const id = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });

    useTabs.getState().closeTab(id);

    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(id);
  });

  it("closing the active tab focuses the left neighbour", () => {
    const a = useTabs.getState().openTab({ kind: "project", projectSlug: "a", title: "A" });
    const b = useTabs.getState().openTab({ kind: "project", projectSlug: "b", title: "B" });
    const c = useTabs.getState().openTab({ kind: "project", projectSlug: "c", title: "C" });
    expect(useTabs.getState().activeTabId).toBe(c);
    useTabs.getState().closeTab(c);
    expect(useTabs.getState().activeTabId).toBe(b);
    useTabs.getState().closeTab(a);
    // a wasn't active, so b stays active
    expect(useTabs.getState().activeTabId).toBe(b);
  });

  it("closing the first active tab focuses the new first tab", () => {
    const a = useTabs.getState().openTab({ kind: "project", projectSlug: "a", title: "A" });
    const b = useTabs.getState().openTab({ kind: "project", projectSlug: "b", title: "B" });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "term", title: "Terminal" });
    useTabs.getState().focusTab(a);

    useTabs.getState().closeTab(a);

    expect(useTabs.getState().activeTabId).toBe(b);
  });

  it("closing the last tab sets active to null", () => {
    const id = useTabs.getState().openTab({ kind: "home", title: "Home" });
    useTabs.getState().closeTab(id);
    expect(useTabs.getState().tabs).toHaveLength(0);
    expect(useTabs.getState().activeTabId).toBeNull();
  });

  it("closes every tab for one project and focuses Home when a project lifecycle action succeeds", () => {
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({ kind: "project", projectSlug: "repo", title: "Repo" });
    useTabs.getState().openTab({ kind: "task", projectSlug: "repo", taskId: "task_1", title: "Task" });
    useTabs.getState().openTab({ kind: "project", projectSlug: "other", title: "Other" });

    useTabs.getState().closeProjectTabs("repo");

    expect(useTabs.getState().tabs.map((tab) => tab.projectSlug)).toEqual([undefined, "other"]);
    expect(useTabs.getState().activeTabId).toBe(home);
  });

  it("retains the active Chat surface as a Global draft when its Project is removed", () => {
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const work = useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "project",
      projectSlug: "repo",
      chatId: "chat_repo",
      chatTitle: "Repo chat",
      chatView: "conversation",
      closable: false,
    });
    useTabs.getState().openTab({ kind: "task", projectSlug: "repo", taskId: "task_1", title: "Task" });
    useTabs.getState().focusTab(work);

    useTabs.getState().closeProjectTabs("repo");

    expect(useTabs.getState().activeTabId).toBe(work);
    expect(useTabs.getState().tabs.find((tab) => tab.id === work)).toMatchObject({
      kind: "work",
      workRoute: "chat",
      chatView: "draft",
      projectSlug: undefined,
      chatId: undefined,
      chatTitle: undefined,
      closable: false,
    });
    expect(useTabs.getState().tabs.some((tab) => tab.taskId === "task_1")).toBe(false);
  });

  it("focusTab ignores unknown ids", () => {
    const id = useTabs.getState().openTab({ kind: "home", title: "Home" });
    useTabs.getState().focusTab("nope");
    expect(useTabs.getState().activeTabId).toBe(id);
  });

  it("renameTab updates the title", () => {
    const id = useTabs.getState().openTab({ kind: "terminal", sessionName: "s", title: "s" });
    useTabs.getState().renameTab(id, "renamed");
    expect(useTabs.getState().tabs.find((t) => t.id === id)!.title).toBe("renamed");
  });

  it("evicts the oldest closable tab beyond the cap", () => {
    const pinned = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    for (let i = 0; i < 30; i++) {
      useTabs.getState().openTab({ kind: "project", projectSlug: `p${i}`, title: `P${i}` });
    }
    const state = useTabs.getState();
    expect(state.tabs.length).toBeLessThanOrEqual(24);
    // The non-closable home tab survives eviction.
    expect(state.tabs.some((t) => t.id === pinned)).toBe(true);
  });

  it("does not evict the previously active tab when opening beyond the cap", () => {
    const active = useTabs.getState().openTab({ kind: "task", taskId: "task-0", title: "P0" });
    const oldestInactive = useTabs.getState().openTab({ kind: "task", taskId: "task-1", title: "P1" });
    for (let i = 2; i < 24; i++) {
      useTabs.getState().openTab({ kind: "task", taskId: `task-${i}`, title: `P${i}` });
    }
    useTabs.getState().focusTab(active);

    useTabs.getState().openTab({ kind: "task", taskId: "task-24", title: "P24" });

    const state = useTabs.getState();
    expect(state.tabs).toHaveLength(24);
    expect(state.tabs.some((t) => t.id === active)).toBe(true);
    expect(state.tabs.some((t) => t.id === oldestInactive)).toBe(false);
  });
});
