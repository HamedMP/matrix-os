import { beforeEach, describe, expect, it } from "vitest";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
});

describe("tabs store", () => {
  it("traverses bounded view history without replacing mounted tab resources", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const terminal = useTabs.getState().openTab({ kind: "terminal", sessionName: "dev", title: "dev" });
    const project = useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });
    const mountedTabs = useTabs.getState().tabs;

    expect(useTabs.getState().canGoBack).toBe(true);
    useTabs.getState().goBack();
    expect(useTabs.getState().activeTabId).toBe(terminal);
    expect(useTabs.getState().tabs).toBe(mountedTabs);

    useTabs.getState().goBack();
    expect(useTabs.getState().activeTabId).toBe(home);
    useTabs.getState().goForward();
    expect(useTabs.getState().activeTabId).toBe(terminal);
    useTabs.getState().goForward();
    expect(useTabs.getState().activeTabId).toBe(project);
    expect(useTabs.getState().canGoForward).toBe(false);
  });

  it("does not duplicate consecutive history entries and drops forward history after a branch", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const terminal = useTabs.getState().openTab({ kind: "terminal", sessionName: "dev", title: "dev" });
    useTabs.getState().focusTab(terminal);

    expect(useTabs.getState().viewHistory).toEqual([home, terminal]);
    useTabs.getState().goBack();
    useTabs.getState().openTab({ kind: "files", title: "Files", slug: "files", closable: false });

    expect(useTabs.getState().viewHistory).toHaveLength(2);
    expect(useTabs.getState().canGoForward).toBe(false);
  });

  it("deduplicates a retained root and drops stale detail Forward history", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({
      kind: "home",
      title: "Home",
      closable: false,
    });
    const projects = useTabs.getState().openTab({
      kind: "projects",
      title: "Projects",
      closable: false,
    });
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    useTabs.getState().focusTab(projects);
    const task = useTabs.getState().openTab({
      kind: "task",
      projectSlug: "matrix-os",
      taskId: "MAT-466",
      title: "Fix Desktop navigation",
    });

    useTabs.getState().openTabAtHistoryRoot({
      kind: "projects",
      title: "Projects",
      closable: false,
    }, ["project", "task"]);

    expect(useTabs.getState()).toMatchObject({
      activeTabId: projects,
      viewHistory: [home, projects],
      historyIndex: 1,
    });
    expect(useTabs.getState().canGoForward).toBe(false);
    expect(useTabs.getState().tabs.some((tab) => tab.id === task)).toBe(true);
  });

  it("keeps unrelated destinations immediately behind a restored Projects root", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({
      kind: "home",
      title: "Home",
      closable: false,
    });
    const projects = useTabs.getState().openTab({
      kind: "projects",
      title: "Projects",
      closable: false,
    });
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    const terminal = useTabs.getState().openTab({
      kind: "terminal",
      sessionName: "canary",
      title: "canary",
    });
    useTabs.getState().openTab({
      kind: "task",
      projectSlug: "matrix-os",
      taskId: "MAT-466",
      title: "Fix Desktop navigation",
    });

    useTabs.getState().openTabAtHistoryRoot({
      kind: "projects",
      title: "Projects",
      closable: false,
    }, ["project", "task"]);

    expect(useTabs.getState()).toMatchObject({
      activeTabId: projects,
      viewHistory: [home, terminal, projects],
      historyIndex: 2,
    });
    useTabs.getState().goBack();
    expect(useTabs.getState().activeTabId).toBe(terminal);
  });

  it("caps view history during long navigation sessions", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const files = useTabs.getState().openTab({ kind: "files", title: "Files", slug: "files", closable: false });

    for (let index = 0; index < 100; index += 1) {
      useTabs.getState().focusTab(index % 2 === 0 ? home : files);
    }

    expect(useTabs.getState().viewHistory.length).toBeLessThanOrEqual(40);
    expect(useTabs.getState().historyIndex).toBe(useTabs.getState().viewHistory.length - 1);
  });

  it("keeps Recents bounded, serializable, filterable, and scoped to one runtime", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    for (let index = 0; index < 20; index += 1) {
      useTabs.getState().recordRecentProject(`project-${index}`, `Project ${index}`);
    }
    useTabs.getState().recordRecentTerminal("dev", "dev");
    useTabs.getState().recordRecentConversation("thread-1", "Fix navigation");

    const state = useTabs.getState();
    expect(state.recentViews.length).toBeLessThanOrEqual(12);
    expect(() => JSON.stringify(state.recentViews)).not.toThrow();
    expect(state.recentViews[0]).toMatchObject({ kind: "conversation", id: "thread-1" });

    state.setRecentFilter("terminal");
    expect(useTabs.getState().recentFilter).toBe("terminal");
    useTabs.getState().ensureNavigationScope("runtime-b");
    expect(useTabs.getState()).toMatchObject({
      navigationScope: "runtime-b",
      recentViews: [],
      viewHistory: [],
      historyIndex: -1,
      recentFilter: "all",
    });
  });

  it("keeps navigation separate from meaningful Recent activity", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const terminal = useTabs.getState().openTab({
      kind: "terminal",
      sessionName: "vivid-otter",
      title: "vivid-otter",
    });
    const project = useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });

    useTabs.getState().focusTab(terminal);
    useTabs.getState().focusTab(project);

    expect(useTabs.getState().recentViews).toEqual([]);

    useTabs.getState().recordRecentTerminal("vivid-otter", "vivid-otter");
    useTabs.getState().recordRecentProject("matrix-os", "Matrix OS");
    expect(useTabs.getState().recentViews.map((recent) => recent.id)).toEqual([
      "matrix-os",
      "vivid-otter",
    ]);
  });

  it("removes deleted resources and reconciles authoritative Hermes and terminal lists", () => {
    useTabs.getState().recordRecentHermesConversation("hermes-live", "Live chat");
    useTabs.getState().recordRecentHermesConversation("hermes-deleted", "Deleted chat");
    useTabs.getState().recordRecentConversation("thread-live", "Coding agent run");
    useTabs.getState().recordRecentTerminal("terminal-live", "terminal-live");
    useTabs.getState().recordRecentTerminal("terminal-deleted", "terminal-deleted");

    useTabs.getState().reconcileRecentHermesConversations(["hermes-live"]);
    useTabs.getState().reconcileRecentTerminals(["terminal-live"]);

    expect(useTabs.getState().recentViews.map((recent) => recent.id)).toEqual([
      "terminal-live",
      "thread-live",
      "hermes-live",
    ]);

    useTabs.getState().removeRecentView("conversation", "hermes-live");
    useTabs.getState().removeRecentView("terminal", "terminal-live");
    expect(useTabs.getState().recentViews.map((recent) => recent.id)).toEqual(["thread-live"]);
  });

  it("atomically closes every missing terminal tab and focuses the nearest retained tab", () => {
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const live = useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-live", title: "matrix-live" });
    const missing = useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-missing", title: "matrix-missing" });
    const alsoMissing = useTabs.getState().openTab({
      kind: "terminal",
      sessionName: "matrix-also-missing",
      title: "matrix-also-missing",
    });
    useTabs.getState().recordRecentTerminal("matrix-live", "matrix-live");
    useTabs.getState().recordRecentTerminal("matrix-missing", "matrix-missing");
    useTabs.getState().requestTerminalSession("matrix-missing");

    useTabs.getState().reconcileTerminalSessions(["matrix-live"]);

    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home, live]);
    expect(useTabs.getState().activeTabId).toBe(live);
    expect(useTabs.getState().viewHistory).not.toContain(missing);
    expect(useTabs.getState().viewHistory).not.toContain(alsoMissing);
    expect(useTabs.getState().recentViews.map((recent) => recent.id)).toEqual(["matrix-live"]);
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
  });

  it("seeds the safe Home root after a runtime transition changes navigation scope", () => {
    const homeId = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });

    useTabs.getState().ensureNavigationScope("runtime-b");

    expect(useTabs.getState()).toMatchObject({
      navigationScope: "runtime-b",
      viewHistory: [homeId],
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false,
    });
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
    expect(useTabs.getState().tabs[0]).toMatchObject({ title: "Chat" });
    expect(useTabs.getState().tabs[0]?.chatId).toBeUndefined();
  });

  it("treats different identities as distinct tabs", () => {
    useTabs.getState().openTab({ kind: "project", projectSlug: "a", title: "A" });
    useTabs.getState().openTab({ kind: "project", projectSlug: "b", title: "B" });
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
    const active = useTabs.getState().openTab({ kind: "project", projectSlug: "p0", title: "P0" });
    const oldestInactive = useTabs.getState().openTab({ kind: "project", projectSlug: "p1", title: "P1" });
    for (let i = 2; i < 24; i++) {
      useTabs.getState().openTab({ kind: "project", projectSlug: `p${i}`, title: `P${i}` });
    }
    useTabs.getState().focusTab(active);

    useTabs.getState().openTab({ kind: "project", projectSlug: "p24", title: "P24" });

    const state = useTabs.getState();
    expect(state.tabs).toHaveLength(24);
    expect(state.tabs.some((t) => t.id === active)).toBe(true);
    expect(state.tabs.some((t) => t.id === oldestInactive)).toBe(false);
  });
});
