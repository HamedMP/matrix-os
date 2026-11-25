// The desktop side of a screenshot (spec 2716) on macOS, Linux and Windows,
// through Electron's desktopCapturer: macOS captures nothing until Screen
// Recording is allowed for Matrix OS, a Linux session that cannot be captured
// says so, and the primary screen comes back as JPEG at most 1600 px wide.
import { describe, expect, it, vi } from "vitest";
import { createDesktopScreenshot, type ScreenSource } from "../../desktop/src/main/desktop-link/screenshot";

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3]);
const source = (displayId: string, empty = false): ScreenSource => ({
  display_id: displayId,
  thumbnail: { isEmpty: () => empty, toJPEG: vi.fn(() => jpeg) },
});

function deps(platform: NodeJS.Platform, overrides: Partial<Parameters<typeof createDesktopScreenshot>[0]> = {}) {
  return {
    platform,
    screenAccess: vi.fn(() => "granted"),
    getSources: vi.fn(async () => [source("7"), source("9")]),
    primaryDisplay: () => ({ id: 9, width: 3200, height: 2000 }),
    ...overrides,
  };
}

describe("desktop screenshot", () => {
  it("captures nothing on macOS without Screen Recording permission", async () => {
    const options = deps("darwin", { screenAccess: vi.fn(() => "denied") });
    expect(await createDesktopScreenshot(options)()).toEqual({ ok: false, reason: "permission" });
    expect(options.getSources).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux", "win32"] as const)("returns the primary screen as JPEG, shrunk to 1600 px, on %s", async (platform) => {
    const options = deps(platform);
    expect(await createDesktopScreenshot(options)()).toEqual({ ok: true, image: jpeg });
    expect(options.getSources).toHaveBeenCalledWith({ types: ["screen"], thumbnailSize: { width: 1600, height: 1000 } });
    // Only macOS gates capture per app.
    expect(options.screenAccess).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
  });

  it("says a Linux session that gives nothing to capture is unavailable, not an empty image", async () => {
    expect(await createDesktopScreenshot(deps("linux", { getSources: vi.fn(async () => []) }))()).toEqual({ ok: false, reason: "unavailable" });
    expect(await createDesktopScreenshot(deps("linux", { getSources: vi.fn(async () => [source("9", true)]) }))()).toEqual({ ok: false, reason: "unavailable" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await createDesktopScreenshot(deps("linux", { getSources: vi.fn(async () => { throw new Error("portal"); }) }))()).toEqual({ ok: false, reason: "unavailable" });
    expect(await createDesktopScreenshot(deps("win32", { getSources: vi.fn(async () => []) }))()).toEqual({ ok: false, reason: "failed" });
  });

  it("gives up on a capture that never answers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hung = deps("win32", { getSources: vi.fn(() => new Promise<ScreenSource[]>(() => undefined)), timeoutMs: 20 });
    expect(await createDesktopScreenshot(hung)()).toEqual({ ok: false, reason: "failed" });
  });
});

describe("what a desktop reports about itself", () => {
  it.each([["darwin", "arm64"], ["linux", "x64"], ["win32", "x64"]] as const)("reports %s %s with terminals, screenshots and no input", async (platform, arch) => {
    const { desktopDeviceInfo } = await import("../../desktop/src/main/desktop-link/register");
    expect(desktopDeviceInfo(platform, arch, true)).toEqual({ platform, arch, capabilities: { terminals: true, screenshot: true, input: false } });
    expect(desktopDeviceInfo(platform, arch, false).capabilities.screenshot).toBe(false);
  });
});
