import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppShimHost, type AppShimLike } from "@desktop/main/installed-apps/shim-host";
import type { InstalledAppRecord } from "@desktop/main/installed-apps/record";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const CDHASH = "70319dee84e8125748db84fee5a36fceda50e82b";
const BUNDLE = "/Users/owner/Applications/Matrix Apps/Notes.app";
const record: InstalledAppRecord = {
  installId: ID, appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name: "Notes",
  iconSha256: "a".repeat(64), bundlePath: BUNDLE, cdHashes: [CDHASH], createdAt: "2026-11-27T10:00:00.000Z",
};

class FakeShim extends EventEmitter implements AppShimLike {
  connected = true;
  readonly quit = vi.fn(() => { this.connected = false; });
  readonly setApplicationMenu = vi.fn();
  readonly satisfiesCodeRequirement = vi.fn((requirement: string) => this.satisfies(requirement));
  constructor(
    readonly bundlePath = BUNDLE,
    readonly bundleId = `com.matrix-os.app.${ID}`,
    private readonly satisfies: (requirement: string) => boolean = (requirement) => requirement.includes(CDHASH),
  ) { super(); }
  isConnected() { return this.connected; }
}

class FakeWindow extends EventEmitter {}

const flush = () => new Promise((settle) => setTimeout(settle, 0));

describe("app shim host", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  function setup(options: { platform?: NodeJS.Platform; teamId?: string | null; records?: () => Promise<InstalledAppRecord[]>;
    openResult?: string; noServerApi?: boolean; startThrows?: boolean; restart?: boolean } = {}) {
    const app = Object.assign(new EventEmitter(), {
      startAppShimServer: options.noServerApi ? undefined : vi.fn(() => { if (options.startThrows) throw new Error("name in use"); }),
      stopAppShimServer: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    });
    const windows: FakeWindow[] = [];
    const service = {
      open: vi.fn(async (_id: string, _context: { appShim?: unknown }) => {
        if (options.openResult) return options.openResult as "limit";
        windows.push(new FakeWindow());
        return "opened" as const;
      }),
      window: vi.fn(() => windows.at(-1) ?? null),
      shimOf: vi.fn((): unknown => undefined),
      saveNow: vi.fn(),
    };
    const buildMenu = vi.fn((_record: InstalledAppRecord, _shim: AppShimLike) => ({ menu: true }));
    const openUrl = vi.fn();
    const confirmRestart = vi.fn(async () => options.restart ?? false);
    const host = createAppShimHost({
      app,
      platform: options.platform ?? "darwin",
      serverName: "matrix-stable",
      records: { list: options.records ?? (async () => [record]) },
      teamId: options.teamId ?? null,
      service,
      buildMenu,
      openUrl,
      confirmRestart,
    });
    const connect = async (shim: FakeShim) => { app.emit("app-shim-connected", {}, shim); await flush(); };
    return { app, host, service, windows, buildMenu, openUrl, confirmRestart, connect };
  }

  it("does nothing off macOS or on an Electron without app shims", () => {
    for (const variant of [{ platform: "win32" as const }, { noServerApi: true }]) {
      const { app, host } = setup(variant);
      expect(host.start()).toBe(false);
      expect(app.listenerCount("app-shim-connected")).toBe(0);
      expect(host.running()).toBe(false);
    }
  });

  it("starts the channel's server, and logs instead of crashing when the name is taken", () => {
    const ok = setup();
    expect(ok.host.start()).toBe(true);
    expect(ok.app.startAppShimServer).toHaveBeenCalledWith({ name: "matrix-stable" });
    ok.host.stop();
    expect(ok.app.stopAppShimServer).toHaveBeenCalledOnce();
    const taken = setup({ startThrows: true });
    expect(taken.host.start()).toBe(false);
    expect(taken.host.running()).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("rejects a shim from a bundle no install record names", async () => {
    const { host, service, connect } = setup();
    host.start();
    const shim = new FakeShim("/Users/owner/Desktop/Evil.app");
    await connect(shim);
    expect(shim.quit).toHaveBeenCalledOnce();
    expect(service.open).not.toHaveBeenCalled();
    expect(shim.satisfiesCodeRequirement).not.toHaveBeenCalled();
  });

  it("rejects a shim whose running code does not match the recorded cdhash", async () => {
    const { host, service, connect } = setup();
    host.start();
    const shim = new FakeShim(BUNDLE, `com.matrix-os.app.${ID}`, () => false);
    await connect(shim);
    expect(shim.satisfiesCodeRequirement).toHaveBeenCalledWith(`cdhash H"${CDHASH}"`);
    expect(shim.quit).toHaveBeenCalledOnce();
    expect(service.open).not.toHaveBeenCalled();
  });

  it("rejects a shim whose bundle identifier is not the install's", async () => {
    const { host, service, connect } = setup();
    host.start();
    const shim = new FakeShim(BUNDLE, "com.matrix-os.app.0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d");
    await connect(shim);
    expect(shim.quit).toHaveBeenCalledOnce();
    expect(service.open).not.toHaveBeenCalled();
  });

  it("pins the team as well as the cdhash when Matrix is team-signed", async () => {
    const { host, service, connect } = setup({ teamId: "ABCDE12345" });
    host.start();
    const shim = new FakeShim();
    await connect(shim);
    expect(shim.satisfiesCodeRequirement).toHaveBeenCalledWith(
      `anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" and cdhash H"${CDHASH}"`);
    expect(service.open).toHaveBeenCalledWith(ID, { appShim: shim });
  });

  it("creates the window inside an accepted shim only after the check, and gives the shim its menu", async () => {
    let release!: (records: InstalledAppRecord[]) => void;
    const { host, service, buildMenu, connect } = setup({ records: () => new Promise((resolve) => { release = resolve; }) });
    host.start();
    const shim = new FakeShim(`${BUNDLE}/`);
    await connect(shim);
    expect(service.open).not.toHaveBeenCalled();
    release([record]);
    await flush();
    expect(shim.satisfiesCodeRequirement.mock.invocationCallOrder[0]!).toBeLessThan(service.open.mock.invocationCallOrder[0]!);
    expect(service.open).toHaveBeenCalledWith(ID, { appShim: shim });
    expect(buildMenu).toHaveBeenCalledWith(record, shim);
    expect(shim.setApplicationMenu).toHaveBeenCalledWith({ menu: true });
    expect(shim.quit).not.toHaveBeenCalled();
  });

  it("handles the shim's activate, quit-requested, open-url and disconnected events", async () => {
    const { host, service, openUrl, connect } = setup();
    host.start();
    const shim = new FakeShim();
    await connect(shim);
    shim.emit("activate", {}, false);
    await flush();
    expect(service.open).toHaveBeenLastCalledWith(ID, { appShim: shim });
    shim.emit("quit-requested", {});
    expect(service.saveNow).toHaveBeenCalledWith(ID);
    shim.emit("open-url", {}, "matrixos://app/x");
    expect(openUrl).toHaveBeenCalledWith("matrixos://app/x");
    shim.connected = false;
    shim.emit("disconnected", {});
    const next = new FakeShim();
    await connect(next);
    expect(next.quit).not.toHaveBeenCalled();
    expect(service.open).toHaveBeenLastCalledWith(ID, { appShim: next });
  });

  it("keeps one shim per install: a second one quits and the first is focused", async () => {
    const { host, service, connect } = setup();
    host.start();
    const first = new FakeShim();
    await connect(first);
    const second = new FakeShim();
    await connect(second);
    expect(second.quit).toHaveBeenCalledOnce();
    expect(first.quit).not.toHaveBeenCalled();
    expect(service.open).toHaveBeenLastCalledWith(ID, { appShim: first });
  });

  it("quits the shim when its window closes, and when no window can open", async () => {
    const ok = setup();
    ok.host.start();
    const shim = new FakeShim();
    await ok.connect(shim);
    ok.windows[0]!.emit("closed");
    expect(shim.quit).toHaveBeenCalledOnce();

    const full = setup({ openResult: "limit" });
    full.host.start();
    const refused = new FakeShim();
    await full.connect(refused);
    expect(refused.quit).toHaveBeenCalledOnce();
  });

  it("quits a connected install's shim on request", async () => {
    const { host, connect } = setup();
    host.start();
    const shim = new FakeShim();
    await connect(shim);
    host.quitShim(ID);
    expect(shim.quit).toHaveBeenCalledOnce();
  });

  it("asks once to restart Matrix after an update replaced it", async () => {
    const later = setup();
    later.host.start();
    later.app.emit("app-shim-version-mismatch", {}, BUNDLE);
    later.app.emit("app-shim-version-mismatch", {}, BUNDLE);
    await flush();
    expect(later.confirmRestart).toHaveBeenCalledOnce();
    expect(later.app.relaunch).not.toHaveBeenCalled();

    const restart = setup({ restart: true });
    restart.host.start();
    restart.app.emit("app-shim-version-mismatch", {}, BUNDLE);
    await flush();
    expect(restart.app.relaunch).toHaveBeenCalledOnce();
    expect(restart.app.quit).toHaveBeenCalledOnce();
  });
});
