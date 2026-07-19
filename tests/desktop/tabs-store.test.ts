import { beforeEach, describe, expect, it } from "vitest";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

beforeEach(() => {
  // Merge (not replace) so the store's action functions are preserved.
  useTabs.setState({ tabs: [], activeTabId: null });
});

describe("tabs store", () => {
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
