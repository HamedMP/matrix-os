import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDesktopDeepLink,
  resolveDesktopChannelIdentity,
  showsReleaseAlignmentNotice,
} from "@desktop/shared/channel-identity";
import { resolveDesktopIdentity } from "@desktop/main/desktop-identity";
import { registerWindowsProtocolClients } from "../../desktop/src/main/platform/protocol-registration";
import { requestDeviceCode } from "../../desktop/src/main/auth/device-auth";

const root = process.cwd();
const canary = resolveDesktopChannelIdentity("canary");
const stable = resolveDesktopChannelIdentity("stable");

describe("desktop channel identity", () => {
  it("gives Canary its own installable identity so it never replaces Matrix OS", () => {
    expect(canary).toMatchObject({
      channel: "canary",
      appName: "Matrix OS Canary",
      appId: "com.matrix-os.operator.canary",
      deepLinkSchemes: ["matrixos-canary"],
      authRedirectUri: "matrixos-canary://auth?status=approved",
    });
    expect(stable).toMatchObject({
      channel: "stable",
      appName: "Matrix OS",
      appId: "com.matrix-os.operator",
      deepLinkSchemes: ["matrixos", "matrix-os"],
      authRedirectUri: "matrixos://auth?status=approved",
    });
  });

  it.each(["beta", "dev", "", undefined, "nightly"])("keeps the stable identity for build channel %j", (channel) => {
    expect(resolveDesktopChannelIdentity(channel)).toMatchObject({ appName: "Matrix OS", appId: "com.matrix-os.operator" });
  });

  it("keeps the canary electron-builder config in step with the runtime identity", async () => {
    const { default: config, loadStableConfig } = await import("../../desktop/electron-builder.canary.mjs");
    const base = loadStableConfig();
    expect(config.extends).toBeUndefined();
    expect(config.appId).toBe(canary.appId);
    expect(config.productName).toBe(canary.appName);
    // Canary must not claim stable's schemes, or approval links would open the wrong app.
    expect(config.protocols).toEqual([{ name: canary.appName, schemes: [...canary.deepLinkSchemes] }]);
    expect(config.dmg.title).toBe(canary.appName);
    expect(config.nsis).toMatchObject({ shortcutName: canary.appName, uninstallDisplayName: canary.appName });
    expect(base.appId).toBe(stable.appId);
    expect(base.productName).toBe(stable.appName);
    expect(base.protocols[0].schemes).toEqual([...stable.deepLinkSchemes]);
    for (const icon of [config.mac.icon, config.dmg.icon, config.win.icon, config.linux.icon]) {
      expect(icon).toMatch(/^build\/icon-canary\.(icns|png)$/);
      expect(existsSync(join(root, "desktop", icon))).toBe(true);
    }
  });

  it("keeps every stable packaging setting other than identity on Canary", async () => {
    const { default: config, loadStableConfig } = await import("../../desktop/electron-builder.canary.mjs");
    const base = loadStableConfig();
    const withoutIdentity = ({ icon: _icon, title: _title, ...rest }: Record<string, unknown>) => rest;
    expect(withoutIdentity(config.mac)).toEqual(withoutIdentity(base.mac));
    expect(withoutIdentity(config.dmg)).toEqual(withoutIdentity(base.dmg));
    expect(config.mac.extraResources).toEqual([{ from: "build/herdr", to: "herdr" }]);
    expect(config.linux.extraResources).toEqual(base.linux.extraResources);
    expect(config.publish).toEqual(base.publish);
    expect(config.files).toEqual(base.files);
    expect(config.generateUpdatesFilesForAllChannels).toBe(true);
  });

  it("routes only the build's own schemes to the running app", () => {
    expect(isDesktopDeepLink("matrixos-canary://auth?status=approved", canary)).toBe(true);
    expect(isDesktopDeepLink("matrixos://auth?status=approved", canary)).toBe(false);
    expect(isDesktopDeepLink("matrixos://auth?status=approved", stable)).toBe(true);
    expect(isDesktopDeepLink("matrix-os://device-auth", stable)).toBe(true);
    expect(isDesktopDeepLink("matrixos-canary://auth", stable)).toBe(false);
    expect(isDesktopDeepLink("not a url", stable)).toBe(false);
  });

  it("shows advisory release-alignment notices only on stable builds", () => {
    for (const status of ["runtime-update-required", "different-releases"] as const) {
      expect(showsReleaseAlignmentNotice({ status, protocol: "compatible" }, "stable")).toBe(true);
      expect(showsReleaseAlignmentNotice({ status, protocol: "legacy" }, "canary")).toBe(false);
      expect(showsReleaseAlignmentNotice({ status, protocol: "compatible" }, "canary")).toBe(false);
      expect(showsReleaseAlignmentNotice({ status, protocol: "compatible" }, "dev")).toBe(false);
    }
    for (const protocol of ["desktop-update-required", "runtime-update-required"] as const) {
      expect(showsReleaseAlignmentNotice({ status: protocol, protocol }, "canary")).toBe(true);
    }
    expect(showsReleaseAlignmentNotice({ status: "aligned", protocol: "compatible" }, "stable")).toBe(false);
    expect(showsReleaseAlignmentNotice({ status: "unavailable", protocol: "unavailable" }, "stable")).toBe(false);
  });
});

describe("desktop identity per build channel", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desktop-channel-identity-"));
    mkdirSync(join(dir, "apps", "Matrix OS"), { recursive: true });
    mkdirSync(join(dir, "apps", "Matrix OS Canary"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("gives Canary its own user data directory and keychain namespace", () => {
    const appDataDir = join(dir, "apps");
    expect(resolveDesktopIdentity({ isPackaged: true, appDataDir, channel: "canary" })).toEqual({
      appName: "Matrix OS Canary",
      userDataDir: join(appDataDir, "Matrix OS Canary"),
    });
    expect(resolveDesktopIdentity({ isPackaged: true, appDataDir, channel: "stable" })).toEqual({
      appName: "Matrix OS",
      userDataDir: undefined,
    });
  });

  it("keeps an explicit profile override on Canary", () => {
    const appDataDir = join(dir, "apps");
    expect(resolveDesktopIdentity({ isPackaged: true, appDataDir, channel: "canary", userDataDir: join(dir, "p") }))
      .toEqual({ appName: "Matrix OS Canary", userDataDir: join(dir, "p") });
  });

  it("refuses QA isolation inside the Canary production profile", () => {
    const appDataDir = join(dir, "apps");
    const nested = join(appDataDir, "Matrix OS Canary", "qa");
    mkdirSync(nested);
    expect(() => resolveDesktopIdentity({ isPackaged: false, appDataDir, qaIdentity: "isolated", userDataDir: nested }))
      .toThrow(/QA identity/);
  });
});

describe("channel-scoped native integration", () => {
  it("registers only Canary's scheme on Windows", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    registerWindowsProtocolClients({ isPackaged: true, setAsDefaultProtocolClient }, "win32", undefined, canary.deepLinkSchemes);
    expect(setAsDefaultProtocolClient.mock.calls).toEqual([["matrixos-canary"]]);
  });

  it("asks the platform to return to the Canary app after browser approval", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      deviceCode: "d", userCode: "U", verificationUri: "https://app.matrix-os.com/auth/device", expiresIn: 600, interval: 5,
    }), { status: 200 }));
    await requestDeviceCode({ fetchFn, baseUrl: "https://app.matrix-os.com", redirectUri: canary.authRedirectUri });
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ clientId: "matrix-os-desktop", redirectUri: "matrixos-canary://auth?status=approved" });
  });
});
