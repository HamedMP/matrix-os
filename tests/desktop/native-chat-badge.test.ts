import { describe, expect, it, vi } from "vitest";
import { setNativeChatBadge } from "../../desktop/src/main/native-chat-badge";

describe("native Chat unread indicator", () => {
  it.each([1, 17, 999])("shows a blank red macOS badge for %i unread chats", (count) => {
    const app = { dock: { setBadge: vi.fn() }, setBadgeCount: vi.fn() };
    setNativeChatBadge(app, "darwin", count);
    expect(app.dock.setBadge).toHaveBeenCalledWith(" ");
    expect(app.setBadgeCount).not.toHaveBeenCalled();
  });
  it("removes the dot when every chat is read", () => {
    const app = { dock: { setBadge: vi.fn() }, setBadgeCount: vi.fn() };
    setNativeChatBadge(app, "darwin", 0);
    expect(app.dock.setBadge).toHaveBeenCalledWith("");
  });
  it("preserves the existing badge API outside macOS", () => {
    const app = { setBadgeCount: vi.fn() };
    setNativeChatBadge(app, "linux", 17);
    expect(app.setBadgeCount).toHaveBeenCalledWith(17);
  });
});
