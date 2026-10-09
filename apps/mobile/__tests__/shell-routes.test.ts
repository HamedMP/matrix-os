import {
  TABS_ROUTE,
  chatScreenFromAnotherTabParams,
  chatScreenParams,
  isChatScreen,
  projectsScreenParams,
  sharedScreenParams,
} from "../lib/shell-routes";

describe("isChatScreen", () => {
  it("is true for the chat screen's segments", () => {
    expect(isChatScreen(["(drawer)", "(tabs)", "(chats)"])).toBe(true);
  });

  it.each([
    ["Shared with me", ["(drawer)", "(tabs)", "(chats)", "shared"]],
    ["Projects", ["(drawer)", "(tabs)", "(chats)", "projects"]],
    ["a project", ["(drawer)", "(tabs)", "(chats)", "projects", "[projectId]"]],
    ["the Agents tab", ["(drawer)", "(tabs)", "agents"]],
    ["the Apps tab", ["(drawer)", "(tabs)", "(apps)", "apps"]],
    ["Files", ["(drawer)", "(tabs)", "(apps)", "files"]],
    ["the Terminal tab", ["(drawer)", "(tabs)", "terminal"]],
    ["the Settings tab", ["(drawer)", "(tabs)", "settings"]],
    ["a screen over the tabs", ["file-browser"]],
    ["the sign-in gate, which is also at /", []],
    ["a shorter path into the tabs", ["(drawer)", "(tabs)"]],
  ])("is false for %s", (_name, segments) => {
    expect(isChatScreen(segments)).toBe(false);
  });
});

describe("navigation params", () => {
  it("names the tabs as the side panel's screen", () => {
    expect(TABS_ROUTE).toBe("(tabs)");
  });

  it("shows the chat screen from the side panel without leaving a param on its URL", () => {
    expect(chatScreenParams()).toEqual({ screen: "(chats)", params: { screen: "index" } });
  });

  it("shows the chat screen from another tab by returning the Chats stack to it", () => {
    expect(chatScreenFromAnotherTabParams()).toEqual({ screen: "(chats)", params: { screen: "index", pop: true } });
  });

  it("opens Shared with me inside the Chats stack", () => {
    expect(sharedScreenParams()).toEqual({ screen: "(chats)", params: { screen: "shared" } });
  });

  it("opens Projects inside the Chats stack, by the name its route file gives the screen", () => {
    expect(projectsScreenParams()).toEqual({ screen: "(chats)", params: { screen: "projects/index" } });
  });

  it("builds new objects on every call, because a used params object is ignored", () => {
    for (const build of [chatScreenParams, chatScreenFromAnotherTabParams, sharedScreenParams, projectsScreenParams]) {
      const first = build();
      const second = build();
      expect(first).not.toBe(second);
      expect(first.params).not.toBe(second.params);
      // React Navigation tags the object it acted on; a frozen one would throw.
      expect(Object.isFrozen(first)).toBe(false);
      expect(Object.isFrozen(first.params)).toBe(false);
    }
  });
});
