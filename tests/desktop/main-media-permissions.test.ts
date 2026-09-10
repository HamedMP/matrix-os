import { describe, expect, it, vi } from "vitest";
import { installMainRendererMediaPermissions } from "../../desktop/src/main/media-permissions";

describe("Electron main renderer microphone policy", () => {
  it("allows audio capture only for the exact trusted main webContents", () => {
    const session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    const mainContents = { id: 42 };
    installMainRendererMediaPermissions(session, mainContents);
    const check = session.setPermissionCheckHandler.mock.calls[0]![0];
    const request = session.setPermissionRequestHandler.mock.calls[0]![0];

    expect(check(mainContents, "media", "file://", { mediaType: "audio", isMainFrame: true })).toBe(true);
    expect(check(mainContents, "media", "file://", { mediaType: "video", isMainFrame: true })).toBe(false);
    expect(check(null, "media", "file://", { mediaType: "audio", isMainFrame: true })).toBe(false);
    expect(check({ id: 99 }, "media", "file://", { mediaType: "audio", isMainFrame: true })).toBe(false);
    expect(check(mainContents, "media", "file://", { mediaType: "audio", isMainFrame: false })).toBe(false);
    expect(check(mainContents, "notifications", "file://", { isMainFrame: true })).toBe(false);

    const allowed = vi.fn();
    request(mainContents, "media", allowed, {
      mediaTypes: ["audio"],
      isMainFrame: true,
      requestingUrl: "file:///renderer/index.html",
    });
    expect(allowed).toHaveBeenCalledWith(true);
    const denied = vi.fn();
    request(mainContents, "media", denied, {
      mediaTypes: ["audio", "video"],
      isMainFrame: true,
      requestingUrl: "file:///renderer/index.html",
    });
    expect(denied).toHaveBeenCalledWith(false);
    const deniedSubframe = vi.fn();
    request(mainContents, "media", deniedSubframe, {
      mediaTypes: ["audio"],
      isMainFrame: false,
      requestingUrl: "https://untrusted.example/embed",
    });
    expect(deniedSubframe).toHaveBeenCalledWith(false);
  });
});
