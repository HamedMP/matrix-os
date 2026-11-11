import { describe, expect, it, vi } from "vitest";
import { installTerminalWindowPermissions } from "@desktop/main/terminal-window/window";

vi.mock("electron", () => ({ BrowserWindow: class {} }));

const TRUSTED = "file:///app/out/renderer/index.html?window=terminal";

describe("Terminal window session permissions", () => {
  function setup() {
    let url = TRUSTED;
    const contents = { getURL: () => url };
    const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
    installTerminalWindowPermissions(session, contents, TRUSTED);
    const check = session.setPermissionCheckHandler.mock.calls[0]![0] as (...args: unknown[]) => boolean;
    const request = session.setPermissionRequestHandler.mock.calls[0]![0] as (...args: unknown[]) => void;
    return { contents, check, request, navigate: (next: string) => { url = next; } };
  }
  const details = { isMainFrame: true, requestingUrl: TRUSTED };

  it("grants clipboard access only to the trusted Terminal document's main frame", () => {
    const { contents, check, request } = setup();
    expect(check(contents, "clipboard-read", "file://", details)).toBe(true);
    expect(check(contents, "clipboard-sanitized-write", "file://", details)).toBe(true);
    const granted = vi.fn();
    request(contents, "clipboard-read", granted, details);
    expect(granted).toHaveBeenCalledWith(true);
  });

  it("denies every other permission, frame, sender and URL", () => {
    const { contents, check, request, navigate } = setup();
    for (const permission of ["media", "geolocation", "notifications", "openExternal", "fullscreen", "pointerLock"]) {
      expect(check(contents, permission, "file://", details), permission).toBe(false);
    }
    expect(check(contents, "clipboard-read", "file://", { ...details, isMainFrame: false })).toBe(false);
    expect(check({ getURL: () => TRUSTED }, "clipboard-read", "file://", details)).toBe(false);
    expect(check(null, "clipboard-read", "file://", details)).toBe(false);
    expect(check(contents, "clipboard-read", "file://", { ...details, requestingUrl: "https://untrusted.example/" })).toBe(false);
    const denied = vi.fn();
    request(contents, "media", denied, details);
    expect(denied).toHaveBeenCalledWith(false);
    navigate("https://untrusted.example/");
    expect(check(contents, "clipboard-read", "file://", details)).toBe(false);
  });
});
