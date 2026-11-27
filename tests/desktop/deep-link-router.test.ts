import { describe, expect, it, vi } from "vitest";
import { createDesktopDeepLinkRouter } from "@desktop/main/deep-links/router";
import { resolveDesktopChannelIdentity } from "@desktop/shared/channel-identity";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const SCOPE = "0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

function setup(hasMainWindow = true) {
  const calls = { focus: vi.fn(), reopen: vi.fn(), send: vi.fn(() => true) };
  const router = createDesktopDeepLinkRouter({
    identity: resolveDesktopChannelIdentity("stable"),
    hasMainWindow: () => hasMainWindow,
    focusMainWindow: calls.focus,
    reopenMainWindow: calls.reopen,
    sendSharedAppLink: calls.send,
  });
  return { router, calls };
}

describe("desktop deep-link router", () => {
  it("opens an installed-app link without raising the main window", () => {
    const { router, calls } = setup();
    const open = vi.fn();
    router.installedApps.ready(open);
    router.route(`matrixos://app/${ID}`);
    expect(open).toHaveBeenCalledWith(ID);
    expect(calls.focus).not.toHaveBeenCalled();
  });

  it("focuses the main window for other links and hands shared-app links to the renderer once it takes", () => {
    const { router, calls } = setup();
    expect(router.sharedApps.take()).toBeNull();
    router.route(`matrixos://shared-app/${SCOPE}`);
    expect(calls.focus).toHaveBeenCalledTimes(1);
    expect(calls.send).toHaveBeenCalledWith({ scopeId: SCOPE });
  });

  it("reopens a closed main window for a non-app link", () => {
    const { router, calls } = setup(false);
    router.route("matrixos://auth?status=approved");
    expect(calls.reopen).toHaveBeenCalledTimes(1);
    expect(calls.focus).not.toHaveBeenCalled();
  });

  it("holds a cold-start installed-app link until its opener is ready", () => {
    const { router } = setup();
    router.coldStart(["/Applications/Matrix OS.app/Contents/MacOS/Matrix OS", `matrixos://app/${ID}`]);
    const open = vi.fn();
    router.installedApps.ready(open);
    expect(open).toHaveBeenCalledWith(ID);
  });

  it("reports whether a second instance's argv carried a link of this channel", () => {
    const { router, calls } = setup();
    expect(router.routeArgv(["--flag"])).toBe(false);
    expect(router.routeArgv([`matrixos-canary://app/${ID}`])).toBe(false);
    expect(router.routeArgv(["matrixos://auth?status=approved"])).toBe(true);
    expect(calls.focus).toHaveBeenCalledTimes(1);
  });
});
