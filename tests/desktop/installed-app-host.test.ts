import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstalledAppHost, type InstalledAppView } from "@desktop/main/installed-apps/app-host";
import { INSTALLED_APP_ACTION_URLS } from "@desktop/main/installed-apps/state-page";
import { NativeAppOpenError } from "@desktop/main/embeds/native-app-open";
import type { InstalledAppRecord } from "@desktop/main/installed-apps/record";
import type { AppLaunchResult } from "@desktop/main/embeds/app-launch";

const RECORD: InstalledAppRecord = {
  installId: "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f",
  appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name: "Notes",
  iconSha256: "a".repeat(64), bundlePath: null, cdHashes: [], createdAt: "2026-11-27T10:00:00.000Z",
};
const TARGET = { slug: "notes", name: "Notes", appIdentity: "notes" };
const LAUNCH_URL = "https://gateway.test/apps/notes/?launch=abc";

const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

function setup(overrides: {
  status?: { signedIn: boolean; runtimeSlot: string; authGeneration: number };
  resolveApp?: () => Promise<typeof TARGET>;
  launch?: () => Promise<AppLaunchResult>;
  loadUrl?: () => Promise<void>;
} = {}) {
  let status = overrides.status ?? { signedIn: true, runtimeSlot: "primary", authGeneration: 3 };
  const shown: string[] = [];
  const window = {
    setTitle: vi.fn(),
    getContentSize: vi.fn((): [number, number] => [800, 600]),
    showState: vi.fn((kind: string) => { shown.push(kind); }),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
  const views: Array<InstalledAppView & { onState: (state: "loading" | "ready" | "failed") => void }> = [];
  const resolveApp = vi.fn(overrides.resolveApp ?? (async () => TARGET));
  const launch = vi.fn(overrides.launch ?? (async (): Promise<AppLaunchResult> => ({ ok: true, url: LAUNCH_URL })));
  const createView = vi.fn(async (_target: typeof TARGET, onState: (state: "loading" | "ready" | "failed") => void) => {
    const view = {
      onState,
      setBounds: vi.fn(),
      attach: vi.fn(),
      loadUrl: vi.fn(overrides.loadUrl ?? (async () => undefined)),
      destroy: vi.fn(),
    };
    views.push(view);
    return view;
  });
  const focusMain = vi.fn();
  const host = createInstalledAppHost({
    record: RECORD, window, getStatus: () => status, resolveApp, launch, createView, focusMain,
  });
  return { host, window, shown, views, resolveApp, launch, createView, focusMain,
    setStatus: (next: typeof status) => { status = next; } };
}

describe("installed app window host", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("validates the app in the catalog, launches it through the session-token path and fills the window", async () => {
    const { host, window, shown, views, resolveApp, launch } = setup();
    await host.load();
    expect(shown).toEqual(["loading"]);
    expect(resolveApp).toHaveBeenCalledWith({ name: "Notes", path: "matrix-app:notes" });
    expect(launch).toHaveBeenCalledWith(TARGET);
    expect(views).toHaveLength(1);
    expect(views[0]!.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 800, height: 600 });
    expect(views[0]!.attach).toHaveBeenCalledOnce();
    expect(views[0]!.loadUrl).toHaveBeenCalledWith(LAUNCH_URL);
    expect(window.setTitle).toHaveBeenCalledWith("Notes");
    views[0]!.onState("ready");
    expect(host.state()).toBe("open");
  });

  it.each([
    ["signed out", { status: { signedIn: false, runtimeSlot: "primary", authGeneration: 3 } }, "signed-out"],
    ["installed from another Matrix computer", { status: { signedIn: true, runtimeSlot: "work", authGeneration: 3 } }, "missing"],
    ["deleted from the catalog", { resolveApp: async () => { throw new NativeAppOpenError("not-found", "installed app unavailable"); } }, "missing"],
    ["replaced by a different app under the same slug", { resolveApp: async () => ({ ...TARGET, appIdentity: "projects/notes" }) }, "missing"],
    ["a catalog that rejects the session", { resolveApp: async () => { throw new NativeAppOpenError("auth-required", "x"); } }, "signed-out"],
    ["an unreachable runtime", { resolveApp: async () => { throw new NativeAppOpenError("catalog-unavailable", "x"); } }, "unavailable"],
    ["an unexpected resolver error", { resolveApp: async () => { throw new Error("postgres: connection refused at /home/matrix"); } }, "unavailable"],
    ["a rejected launch credential", { launch: async (): Promise<AppLaunchResult> => ({ ok: false, state: "auth-required" }) }, "signed-out"],
    ["a failed launch", { launch: async (): Promise<AppLaunchResult> => ({ ok: false, state: "failed" }) }, "unavailable"],
    ["a launch that throws", { launch: async (): Promise<AppLaunchResult> => { throw new Error("raw"); } }, "unavailable"],
  ] as const)("shows a safe state, not the app, when %s", async (_label, overrides, expected) => {
    const { host, shown, views } = setup(overrides as never);
    await host.load();
    expect(shown.at(-1)).toBe(expected);
    expect(host.state()).toBe(expected);
    expect(views).toHaveLength(0);
  });

  it("does not call the catalog while signed out", async () => {
    const { host, resolveApp } = setup({ status: { signedIn: false, runtimeSlot: "primary", authGeneration: 1 } });
    await host.load();
    expect(resolveApp).not.toHaveBeenCalled();
  });

  it("refuses native browser products, which need the embedded browser lifecycle", async () => {
    const { host, launch } = setup({ resolveApp: async () => ({ slug: "browser-lab", name: "Browser", appIdentity: "matrix-browser" }) });
    await host.load();
    expect(host.state()).toBe("unavailable");
    expect(launch).not.toHaveBeenCalled();
  });

  it("replaces a view that fails to load with the unavailable state", async () => {
    const { host, shown, views } = setup();
    await host.load();
    views[0]!.onState("failed");
    expect(views[0]!.destroy).toHaveBeenCalledOnce();
    expect(shown.at(-1)).toBe("unavailable");
    const rejected = setup({ loadUrl: async () => { throw new Error("ERR_CONNECTION_REFUSED"); } });
    await rejected.host.load();
    expect(rejected.views[0]!.destroy).toHaveBeenCalledOnce();
    expect(rejected.host.state()).toBe("unavailable");
  });

  it("retries from a failure state and ignores retry while the app is open", async () => {
    let fail = true;
    const { host, views, resolveApp } = setup({
      resolveApp: async () => { if (fail) throw new NativeAppOpenError("catalog-unavailable", "x"); return TARGET; },
    });
    await host.load();
    fail = false;
    expect(host.handleNavigation(INSTALLED_APP_ACTION_URLS.retry)).toBe(true);
    await flush();
    await flush();
    expect(views).toHaveLength(1);
    views[0]!.onState("ready");
    host.handleNavigation(INSTALLED_APP_ACTION_URLS.retry);
    await flush();
    expect(resolveApp).toHaveBeenCalledTimes(2);
  });

  it("focuses Matrix from the signed-out state and treats other URLs as not ours", async () => {
    const { host, focusMain } = setup({ status: { signedIn: false, runtimeSlot: "primary", authGeneration: 1 } });
    await host.load();
    expect(host.handleNavigation(INSTALLED_APP_ACTION_URLS.openMatrix)).toBe(true);
    expect(focusMain).toHaveBeenCalledOnce();
    expect(host.handleNavigation("https://installed-app.matrix-os.invalid/uninstall")).toBe(false);
    expect(host.handleNavigation("https://evil.test/retry")).toBe(false);
  });

  it("drops a superseded load so only the latest attempt creates a view", async () => {
    const releases: Array<() => void> = [];
    const { host, views } = setup({
      resolveApp: () => new Promise((resolve) => { releases.push(() => resolve(TARGET)); }),
    });
    const first = host.load();
    const second = host.load();
    releases[1]!();
    await second;
    releases[0]!();
    await first;
    expect(views).toHaveLength(1);
  });

  it("closes an open app when the session changes and reloads a signed-out window after sign-in", async () => {
    const open = setup();
    await open.host.load();
    open.host.authChanged({ signedIn: true, runtimeSlot: "primary", authGeneration: 3 });
    expect(open.window.close).not.toHaveBeenCalled();
    open.host.authChanged({ signedIn: true, runtimeSlot: "work", authGeneration: 4 });
    expect(open.window.close).toHaveBeenCalledOnce();

    const signedOut = setup({ status: { signedIn: false, runtimeSlot: "primary", authGeneration: 1 } });
    await signedOut.host.load();
    signedOut.setStatus({ signedIn: true, runtimeSlot: "primary", authGeneration: 2 });
    signedOut.host.authChanged({ signedIn: true, runtimeSlot: "primary", authGeneration: 2 });
    await flush();
    await flush();
    expect(signedOut.window.close).not.toHaveBeenCalled();
    expect(signedOut.views).toHaveLength(1);
  });

  it("resizes the app view with the window and tears it down on dispose", async () => {
    const { host, window, views } = setup();
    await host.load();
    window.getContentSize.mockReturnValue([1200, 900]);
    host.resize();
    expect(views[0]!.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 900 });
    host.dispose();
    expect(views[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("never creates a view for a load that settles after dispose", async () => {
    let release!: () => void;
    const { host, views, window } = setup({ resolveApp: () => new Promise((resolve) => { release = () => resolve(TARGET); }) });
    const pending = host.load();
    host.dispose();
    release();
    await pending;
    expect(views).toHaveLength(0);
    expect(window.showState).toHaveBeenCalledTimes(1);
  });
});
