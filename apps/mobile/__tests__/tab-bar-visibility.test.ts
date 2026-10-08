import {
  TAB_BAR_HIDDEN_ROUTES,
  focusedNestedRouteName,
  isTabBarHidden,
} from "../lib/tab-bar-visibility";

describe("isTabBarHidden", () => {
  it("keeps the tab bar on every screen that exists today", () => {
    expect(TAB_BAR_HIDDEN_ROUTES).toEqual({});
    for (const [tab, nested] of [
      ["(chats)", "index"],
      ["(chats)", "shared"],
      ["agents", "index"],
      ["(apps)", "apps"],
      ["(apps)", "files"],
      ["(apps)", "integrations"],
      ["terminal", undefined],
      ["settings", undefined],
    ] as const) {
      expect(isTabBarHidden(tab, nested)).toBe(false);
    }
  });

  it("hides it for a listed screen of the focused tab only", () => {
    const hidden = { agents: ["[agentId]", "new"], "(chats)": ["instructions"] };

    expect(isTabBarHidden("agents", "[agentId]", hidden)).toBe(true);
    expect(isTabBarHidden("agents", "new", hidden)).toBe(true);
    expect(isTabBarHidden("(chats)", "instructions", hidden)).toBe(true);
    expect(isTabBarHidden("agents", "index", hidden)).toBe(false);
    // The same screen name under another tab is another screen.
    expect(isTabBarHidden("(chats)", "new", hidden)).toBe(false);
    expect(isTabBarHidden("settings", "new", hidden)).toBe(false);
  });

  it("keeps it for a tab that has no navigator of its own", () => {
    expect(isTabBarHidden("agents", undefined, { agents: ["new"] })).toBe(false);
  });

  it("does not mistake an inherited object key for a tab", () => {
    expect(isTabBarHidden("constructor", "name", { agents: ["new"] })).toBe(false);
    expect(isTabBarHidden("toString", "length")).toBe(false);
  });
});

describe("focusedNestedRouteName", () => {
  it("reads the focused screen of the tab's own navigator", () => {
    expect(focusedNestedRouteName({
      state: { index: 1, routes: [{ name: "apps" }, { name: "files" }] },
    })).toBe("files");
    expect(focusedNestedRouteName({
      state: { index: 0, routes: [{ name: "apps" }, { name: "files" }] },
    })).toBe("apps");
  });

  it("takes the last screen of a stack restored from a link, which has no index", () => {
    expect(focusedNestedRouteName({
      state: { routes: [{ name: "apps" }, { name: "integrations" }] },
    })).toBe("integrations");
    expect(focusedNestedRouteName({
      state: { type: "stack", routes: [{ name: "apps" }, { name: "integrations" }] },
    })).toBe("integrations");
  });

  it("takes the first screen of any other navigator restored without an index", () => {
    expect(focusedNestedRouteName({
      state: { type: "tab", routes: [{ name: "first" }, { name: "second" }] },
    })).toBe("first");
  });

  it("falls back to the screen the tab was asked to open before its navigator has rendered", () => {
    expect(focusedNestedRouteName({ params: { screen: "shared" } })).toBe("shared");
    expect(focusedNestedRouteName({ params: { screen: 4 } })).toBeUndefined();
  });

  it("is undefined for a tab that is a single screen", () => {
    expect(focusedNestedRouteName({})).toBeUndefined();
    expect(focusedNestedRouteName({ params: { name: "main" } })).toBeUndefined();
  });
});
