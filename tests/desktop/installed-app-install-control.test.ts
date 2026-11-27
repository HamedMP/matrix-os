import { describe, expect, it, vi } from "vitest";
import { createInstallControl, type InstallControlDeps } from "../../desktop/src/main/installed-apps/install-control";
import { InstalledAppsUnavailableError, installErrorCode } from "../../desktop/src/main/installed-apps/install-ipc";
import type { InstalledAppRecord } from "../../desktop/src/main/installed-apps/record";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const RECORD: InstalledAppRecord = {
  installId: ID, appIdentity: "team-tracker", slug: "team-tracker", runtimeSlot: "primary", name: "Team Tracker",
  iconSha256: "a".repeat(64), bundlePath: "/apps/Team Tracker.app", cdHashes: [], createdAt: "2026-11-27T10:00:00.000Z",
};
const REQUEST = { name: "Team Tracker", path: "matrix-app:team-tracker" };
const TARGET = { slug: "team-tracker", name: "Team Tracker", appIdentity: "team-tracker" };

function deps(overrides: Partial<InstallControlDeps> = {}): InstallControlDeps {
  return {
    mac: null,
    launchers: () => null,
    records: { list: async () => [RECORD], get: async () => RECORD },
    resolveApp: async () => TARGET,
    session: () => ({ signedIn: true, runtimeSlot: "primary", authGeneration: 3 }),
    closeWindow: vi.fn(),
    launch: vi.fn(async () => undefined),
    reveal: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
}

/** A control bound to `d` whose startup has finished. */
async function ready(d: InstallControlDeps) {
  const installs = createInstallControl();
  installs.bind(d);
  await installs.runStartup(async () => undefined);
  return installs.control;
}

const linux = (install = vi.fn(async () => RECORD), uninstall = vi.fn(async () => true)) =>
  ({ platform: "linux" as const, installer: { install, uninstall } });

describe("install control", () => {
  it("exists before installed apps are wired and reports unavailable until startup completes", async () => {
    const installs = createInstallControl();
    expect(installs.control.platform()).toBeNull();
    await expect(installs.control.list()).resolves.toEqual([]);
    await expect(installs.control.install(REQUEST)).rejects.toBeInstanceOf(InstalledAppsUnavailableError);
    await expect(installs.control.show(ID)).resolves.toBe(false);
    // Bound, but startup still running: still unavailable.
    const d = deps({ launchers: () => linux() });
    installs.bind(d);
    expect(installs.control.platform()).toBeNull();
    let finish: () => void = () => undefined;
    const startup = installs.runStartup(() => new Promise<void>((resolve) => { finish = resolve; }));
    expect(installs.control.platform()).toBeNull();
    expect(d.onChanged).not.toHaveBeenCalled();
    finish();
    await startup;
    expect(d.onChanged).toHaveBeenCalledTimes(1);
    expect(installs.control.platform()).toBe("linux");
  });

  it("refuses to be wired twice", () => {
    const installs = createInstallControl();
    installs.bind(deps());
    expect(() => installs.bind(deps())).toThrow();
  });

  it("reports availability again once macOS startup finishes", async () => {
    let shimsRunning = false;
    const d = deps({ mac: { available: () => shimsRunning, install: async () => RECORD, uninstall: async () => true } });
    const installs = createInstallControl();
    installs.bind(d);
    await installs.runStartup(async () => { shimsRunning = true; });
    expect(d.onChanged).toHaveBeenCalledTimes(1);
    expect(installs.control.platform()).toBe("mac");
  });

  it("still tells the renderer when startup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = deps({ mac: { available: () => false, install: async () => RECORD, uninstall: async () => true } });
    const installs = createInstallControl();
    installs.bind(d);
    await installs.runStartup(async () => { throw new Error("shim server failed"); });
    expect(d.onChanged).toHaveBeenCalledTimes(1);
    expect(installs.control.platform()).toBeNull();
    warn.mockRestore();
  });

  it("is unavailable on Linux without launchers", async () => {
    const control = await ready(deps());
    expect(control.platform()).toBeNull();
    await expect(control.install(REQUEST)).rejects.toBeInstanceOf(InstalledAppsUnavailableError);
    await expect(control.uninstall(ID)).rejects.toBeInstanceOf(InstalledAppsUnavailableError);
  });

  it("installs the catalog app for the computer it was asked on, reports it and opens it", async () => {
    const install = vi.fn(async () => RECORD);
    const d = deps({ launchers: () => linux(install) });
    const control = await ready(d);
    await expect(control.install(REQUEST)).resolves.toBe(RECORD);
    expect(install).toHaveBeenCalledWith({ appIdentity: "team-tracker", slug: "team-tracker", runtimeSlot: "primary", name: "Team Tracker" });
    expect(d.onChanged).toHaveBeenCalledTimes(2);
    expect(d.launch).toHaveBeenCalledWith(ID);
  });

  it("saves nothing when the computer or session changes while the catalog resolves", async () => {
    for (const after of [
      { signedIn: true, runtimeSlot: "work", authGeneration: 3 },
      { signedIn: true, runtimeSlot: "primary", authGeneration: 4 },
      { signedIn: false, runtimeSlot: "primary", authGeneration: 4 },
    ]) {
      let session = { signedIn: true, runtimeSlot: "primary", authGeneration: 3 };
      const install = vi.fn(async () => RECORD);
      const control = await ready(deps({
        launchers: () => linux(install),
        session: () => session,
        resolveApp: async () => { session = after; return TARGET; },
      }));
      const failure = await control.install(REQUEST).then(() => null, (error: unknown) => error);
      expect(installErrorCode(failure)).toBe(after.signedIn ? "failed" : "auth-required");
      expect(install).not.toHaveBeenCalled();
    }
  });

  it("asks for sign-in before resolving when signed out", async () => {
    const resolveApp = vi.fn(async () => TARGET);
    const control = await ready(deps({
      launchers: () => linux(),
      resolveApp,
      session: () => ({ signedIn: false, runtimeSlot: "primary", authGeneration: 0 }),
    }));
    expect(installErrorCode(await control.install(REQUEST).catch((error: unknown) => error))).toBe("auth-required");
    expect(resolveApp).not.toHaveBeenCalled();
  });

  it("closes the window before uninstalling and reports only a real removal", async () => {
    const uninstall = vi.fn(async (installId: string) => installId === ID);
    const d = deps({ launchers: () => linux(undefined, uninstall) });
    const control = await ready(d);
    await expect(control.uninstall(ID)).resolves.toBe(true);
    expect(d.closeWindow).toHaveBeenCalledWith(ID);
    await expect(control.uninstall("0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d")).resolves.toBe(false);
    expect(d.onChanged).toHaveBeenCalledTimes(2);
  });

  it("reveals the recorded bundle or launcher", async () => {
    const d = deps();
    const control = await ready(d);
    await expect(control.show(ID)).resolves.toBe(true);
    expect(d.reveal).toHaveBeenCalledWith("/apps/Team Tracker.app");
  });
});
