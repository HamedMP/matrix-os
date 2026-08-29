import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopIcons } from "@desktop/renderer/src/stores/desktop-icons";

const CHAT = { path: "__chat__", x: 20, y: 20 };
const FILES = { path: "__file-browser__", x: 108, y: 20 };

describe("native Desktop icon layout", () => {
  beforeEach(() => useDesktopIcons.setState(useDesktopIcons.getInitialState(), true));

  it("loads the owner-controlled layout from desktop settings", async () => {
    const api = { get: vi.fn(async () => ({ desktopIcons: [FILES] })) };

    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    expect(useDesktopIcons.getState().icons).toEqual([FILES]);
  });

  it("persists moving, removing, and adding icons through the bounded desktop patch", async () => {
    const api = {
      get: vi.fn(async () => ({ desktopIcons: [CHAT, FILES] })),
      patch: vi.fn(async () => ({ ok: true })),
    };
    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    await useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    await useDesktopIcons.getState().remove("__file-browser__", api as never);
    await useDesktopIcons.getState().add("apps/notes/index.html", api as never);

    expect(useDesktopIcons.getState().icons).toContainEqual({ path: "__chat__", x: 240, y: 180 });
    expect(useDesktopIcons.getState().icons.some((icon) => icon.path === "__file-browser__")).toBe(false);
    expect(useDesktopIcons.getState().icons.some((icon) => icon.path === "apps/notes/index.html")).toBe(true);
    expect(api.patch).toHaveBeenLastCalledWith("/api/settings/desktop", {
      desktopIcons: useDesktopIcons.getState().icons,
    });
  });
});
