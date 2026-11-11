import {
  CHAT_SCREEN_HREF,
  PROJECTS_SCREEN_HREF,
  SHARED_SCREEN_HREF,
  TABS_ROUTE,
  isChatScreen,
  tabScreenHref,
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

describe("shell hrefs", () => {
  it("names the tabs as the side panel's screen", () => {
    expect(TABS_ROUTE).toBe("(tabs)");
  });

  it("reaches the chat screen through the side panel's group, since the bare / is the sign-in gate", () => {
    expect(CHAT_SCREEN_HREF).toBe("/(drawer)");
  });

  it("opens Shared with me and Projects by their URLs in the Chats stack", () => {
    expect(SHARED_SCREEN_HREF).toBe("/shared");
    expect(PROJECTS_SCREEN_HREF).toBe("/projects");
  });

  it("shows a tab that is a single screen by its URL", () => {
    expect(tabScreenHref("terminal")).toBe("/terminal");
    expect(tabScreenHref("settings")).toBe("/settings");
  });
});
