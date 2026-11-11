import {
  TAB_BAR_HIDDEN_ROUTES,
  focusedNestedRouteName,
  isTabBarHidden,
} from "../lib/tab-bar-visibility";

describe("isTabBarHidden", () => {
  it("hides the tab bar on the New agent screen and on an agent's chat, and shows it on the Agents list", () => {
    expect(TAB_BAR_HIDDEN_ROUTES).toEqual({ agents: ["new", "[agentId]"] });
    expect(isTabBarHidden("agents", "new")).toBe(true);
    expect(isTabBarHidden("agents", "[agentId]")).toBe(true);
    expect(isTabBarHidden("agents", "index")).toBe(false);
    // Another tab's screen of the same name is neither of them.
    expect(isTabBarHidden("(chats)", "new")).toBe(false);
    expect(isTabBarHidden("(chats)", "[agentId]")).toBe(false);
  });

  it("keeps the tab bar on every other screen that exists today", () => {
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
  it("reads the screen after the tab's own segment", () => {
    expect(focusedNestedRouteName(["(drawer)", "(tabs)", "agents", "new"], "agents")).toBe("new");
    expect(focusedNestedRouteName(["(drawer)", "(tabs)", "agents", "[agentId]"], "agents")).toBe("[agentId]");
    expect(focusedNestedRouteName(["(drawer)", "(tabs)", "(apps)", "files"], "(apps)")).toBe("files");
  });

  it("is undefined on a tab's index screen, which adds no segment", () => {
    expect(focusedNestedRouteName(["(drawer)", "(tabs)", "agents"], "agents")).toBeUndefined();
    expect(focusedNestedRouteName(["(drawer)", "(tabs)", "(chats)"], "(chats)")).toBeUndefined();
  });

  it("is undefined for a tab that is a single screen", () => {
    expect(focusedNestedRouteName(["(drawer)", "(tabs)", "settings"], "settings")).toBeUndefined();
  });

  it("is undefined while the segments name another tab", () => {
    expect(focusedNestedRouteName(["(drawer)", "(tabs)", "agents", "new"], "(chats)")).toBeUndefined();
    expect(focusedNestedRouteName([], "agents")).toBeUndefined();
  });
});
