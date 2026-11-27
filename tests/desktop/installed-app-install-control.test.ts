import { describe, expect, it, vi } from "vitest";
import { createInstallControl, type InstallControlDeps } from "../../desktop/src/main/installed-apps/install-control";
import { InstalledAppsUnavailableError } from "../../desktop/src/main/installed-apps/install-ipc";
import type { InstalledAppRecord } from "../../desktop/src/main/installed-apps/record";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const RECORD: InstalledAppRecord = {
  installId: ID, appIdentity: "team-tracker", slug: "team-tracker", runtimeSlot: "primary", name: "Team Tracker",
  iconSha256: "a".repeat(64), bundlePath: "/apps/Team Tracker.app", cdHashes: [], createdAt: "2026-11-27T10:00:00.000Z",
};

function deps(overrides: Partial<InstallControlDeps> = {}): InstallControlDeps {
  return {
    mac: null,
    launchers: () => null,
    records: { list: async () => [RECORD], get: async () => RECORD },
    resolveApp: async () => ({ slug: "team-tracker", name: "Team Tracker", appIdentity: "team-tracker" }),
    runtimeSlot: () => "primary",
    closeWindow: vi.fn(),
    launch: vi.fn(async () => undefined),
    reveal: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
}

describe("install control", () => {
  it("reports availability again once macOS startup finishes", async () => {
    let shimsRunning = false;
    const onChanged = vi.fn();
    const { control, runStartup } = createInstallControl(deps({
      onChanged,
      mac: { available: () => shimsRunning, install: async () => RECORD, uninstall: async () => true },
    }));
    // Asked while the shim server is still starting: not yet available.
    expect(control.platform()).toBeNull();
    let finish: () => void = () => undefined;
    const startup = runStartup(() => new Promise<void>((resolve) => { finish = () => { shimsRunning = true; resolve(); }; }));
    expect(onChanged).not.toHaveBeenCalled();
    finish();
    await startup;
    // The renderer re-reads the list on this event and now sees installs available.
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(control.platform()).toBe("mac");
  });

  it("still tells the renderer when startup fails", async () => {
    const onChanged = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { control, runStartup } = createInstallControl(deps({
      onChanged, mac: { available: () => false, install: async () => RECORD, uninstall: async () => true },
    }));
    await runStartup(async () => { throw new Error("shim server failed"); });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(control.platform()).toBeNull();
    warn.mockRestore();
  });

  it("is unavailable on Linux until launchers resolve, and stays so without a usable command", async () => {
    let launchers: ReturnType<InstallControlDeps["launchers"]> = null;
    const { control } = createInstallControl(deps({ launchers: () => launchers }));
    expect(control.platform()).toBeNull();
    await expect(control.install({ name: "Team Tracker", path: "matrix-app:team-tracker" })).rejects.toBeInstanceOf(InstalledAppsUnavailableError);
    await expect(control.uninstall(ID)).rejects.toBeInstanceOf(InstalledAppsUnavailableError);
    launchers = { platform: "linux", installer: { install: async () => RECORD, uninstall: async () => true } };
    expect(control.platform()).toBe("linux");
  });

  it("installs the catalog app for the current computer, reports it and opens it", async () => {
    const install = vi.fn(async () => RECORD);
    const d = deps({ launchers: () => ({ platform: "windows", installer: { install, uninstall: async () => true } }) });
    const { control } = createInstallControl(d);
    await expect(control.install({ name: "anything", path: "matrix-app:team-tracker" })).resolves.toBe(RECORD);
    expect(install).toHaveBeenCalledWith({ appIdentity: "team-tracker", slug: "team-tracker", runtimeSlot: "primary", name: "Team Tracker" });
    expect(d.onChanged).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledWith(ID);
  });

  it("closes the window before uninstalling and reports only a real removal", async () => {
    const uninstall = vi.fn(async (installId: string) => installId === ID);
    const d = deps({ launchers: () => ({ platform: "linux", installer: { install: async () => RECORD, uninstall } }) });
    const { control } = createInstallControl(d);
    await expect(control.uninstall(ID)).resolves.toBe(true);
    expect(d.closeWindow).toHaveBeenCalledWith(ID);
    await expect(control.uninstall("0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d")).resolves.toBe(false);
    expect(d.onChanged).toHaveBeenCalledTimes(1);
  });

  it("reveals the recorded bundle or launcher", async () => {
    const d = deps();
    const { control } = createInstallControl(d);
    await expect(control.show(ID)).resolves.toBe(true);
    expect(d.reveal).toHaveBeenCalledWith("/apps/Team Tracker.app");
  });
});
