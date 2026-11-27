import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstalledAppsService } from "@desktop/main/installed-apps/service";
import type { InstalledAppRecord } from "@desktop/main/installed-apps/record";

type Listener = () => void;
function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  let destroyed = false;
  const win = {
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); }),
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    close: vi.fn(() => { if (destroyed) return; emit("close"); destroyed = true; emit("closed"); }),
    getBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }),
  };
  const emit = (event: string) => { for (const listener of listeners.get(event) ?? []) listener(); };
  return win;
}

const record = (suffix: string): InstalledAppRecord => ({
  installId: `6f1c2a4e-2b7d-4c1a-9f3e-${suffix.padStart(12, "0")}`,
  appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name: "Notes",
  iconSha256: "a".repeat(64), bundlePath: null, cdHashes: [], createdAt: "2026-11-27T10:00:00.000Z",
});

describe("installed apps service", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  function setup() {
    const records = [record("1"), record("2")];
    const hosts: Array<{ installId: string; load: ReturnType<typeof vi.fn>; authChanged: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
    const windows: Array<ReturnType<typeof fakeWindow>> = [];
    const service = createInstalledAppsService({
      records: { get: async (id) => records.find((item) => item.installId === id) ?? null },
      windowState: { load: async () => null, save: vi.fn(async () => undefined) },
      fitBounds: (bounds) => ({ x: 0, y: 0, minWidth: 480, minHeight: 320, ...bounds }),
      createWindow: (item) => {
        const window = fakeWindow();
        windows.push(window);
        const host = { installId: item.installId, load: vi.fn(async () => undefined), authChanged: vi.fn(), dispose: vi.fn() };
        hosts.push(host);
        return { window, host };
      },
    });
    return { service, records, hosts, windows };
  }

  it("loads each new window's content once and focuses instead of reloading", async () => {
    const { service, records, hosts } = setup();
    expect(await service.open(records[0]!.installId)).toBe("opened");
    expect(await service.open(records[0]!.installId)).toBe("focused");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.load).toHaveBeenCalledOnce();
  });

  it("hands every session change to the open windows and stops after a window closes", async () => {
    const { service, records, hosts, windows } = setup();
    await service.open(records[0]!.installId);
    await service.open(records[1]!.installId);
    const signedOut = { signedIn: false, runtimeSlot: "primary", authGeneration: 9 };
    service.authChanged(signedOut);
    expect(hosts.map((host) => host.authChanged.mock.calls)).toEqual([[[signedOut]], [[signedOut]]]);
    windows[0]!.close();
    expect(hosts[0]!.dispose).toHaveBeenCalledOnce();
    service.authChanged({ ...signedOut, authGeneration: 10 });
    expect(hosts[0]!.authChanged).toHaveBeenCalledTimes(1);
    expect(hosts[1]!.authChanged).toHaveBeenCalledTimes(2);
  });

  it("closes every window and tears down hosts on dispose", async () => {
    const { service, records, hosts, windows } = setup();
    await service.open(records[0]!.installId);
    await service.dispose();
    expect(windows[0]!.close).toHaveBeenCalledOnce();
    expect(hosts[0]!.dispose).toHaveBeenCalledOnce();
    expect(await service.open(records[1]!.installId)).toBe("unavailable");
  });
});
