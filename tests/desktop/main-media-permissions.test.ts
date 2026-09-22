import { describe, expect, it, vi } from "vitest";
import { installMainRendererMediaPermissions } from "../../desktop/src/main/media-permissions";

describe("Electron main renderer microphone policy", () => {
  it("allows audio capture only for the exact trusted main renderer location", () => {
    const session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    let currentUrl = "file:///Applications/Matrix%20OS/resources/app.asar/out/renderer/index.html";
    const mainContents = { id: 42, getURL: () => currentUrl };
    installMainRendererMediaPermissions(session, mainContents, currentUrl);
    const check = session.setPermissionCheckHandler.mock.calls[0]![0];
    const request = session.setPermissionRequestHandler.mock.calls[0]![0];

    const trustedDetails = { mediaType: "audio", isMainFrame: true, requestingUrl: currentUrl };
    expect(check(mainContents, "media", "file://", trustedDetails)).toBe(true);
    expect(check(mainContents, "media", "file://", { ...trustedDetails, mediaType: "video" })).toBe(false);
    expect(check(null, "media", "file://", trustedDetails)).toBe(false);
    expect(check({ id: 99 }, "media", "file://", trustedDetails)).toBe(false);
    expect(check(mainContents, "media", "file://", { ...trustedDetails, isMainFrame: false })).toBe(false);
    expect(check(mainContents, "media", "file://", {
      ...trustedDetails,
      requestingUrl: "https://untrusted.example/embed",
    })).toBe(false);

    const allowed = vi.fn();
    request(mainContents, "media", allowed, {
      mediaTypes: ["audio"],
      isMainFrame: true,
      requestingUrl: currentUrl,
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

    currentUrl = "https://untrusted.example/navigation";
    expect(check(mainContents, "media", "https://untrusted.example", trustedDetails)).toBe(false);
    const deniedNavigation = vi.fn();
    request(mainContents, "media", deniedNavigation, {
      mediaTypes: ["audio"],
      isMainFrame: true,
      requestingUrl: currentUrl,
    });
    expect(deniedNavigation).toHaveBeenCalledWith(false);
  });

  it("preserves only the trusted main renderer clipboard permissions", () => {
    const session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    const trustedUrl = "http://desktop.localhost:5173/";
    const mainContents = { id: 42, getURL: () => trustedUrl };
    installMainRendererMediaPermissions(session, mainContents, trustedUrl);
    const check = session.setPermissionCheckHandler.mock.calls[0]![0];
    const request = session.setPermissionRequestHandler.mock.calls[0]![0];
    const details = { isMainFrame: true, requestingUrl: `${trustedUrl}chat` };

    expect(check(mainContents, "clipboard-read", trustedUrl, details)).toBe(true);
    expect(check(mainContents, "clipboard-sanitized-write", trustedUrl, details)).toBe(true);
    expect(check(mainContents, "notifications", trustedUrl, details)).toBe(false);
    expect(check(mainContents, "clipboard-read", trustedUrl, { ...details, isMainFrame: false })).toBe(false);
    expect(check(mainContents, "clipboard-read", trustedUrl, {
      ...details,
      requestingUrl: "https://untrusted.example/",
    })).toBe(false);

    const clipboardAllowed = vi.fn();
    request(mainContents, "clipboard-read", clipboardAllowed, details);
    expect(clipboardAllowed).toHaveBeenCalledWith(true);
    const notificationDenied = vi.fn();
    request(mainContents, "notifications", notificationDenied, details);
    expect(notificationDenied).toHaveBeenCalledWith(false);
  });
});
