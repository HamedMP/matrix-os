import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Electron and OS encryption are system boundaries. The real entrypoint,
// AuthService, local store, credential store and all service factories execute.
const host = vi.hoisted(() => {
  const ipc = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const windows: any[] = [];
  const appEvents = new Map<string, (...args: any[]) => void>();
  const requests = { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() };
  const targetSession = { webRequest: requests, setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    cookies: { on: vi.fn() } };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s),
    decryptString: vi.fn((b: Buffer) => b.toString()) };
  const update = { setFeedURL: vi.fn(), removeAllListeners: vi.fn(), once: vi.fn(), on: vi.fn(),
    checkForUpdates: vi.fn(async () => ({})), quitAndInstall: vi.fn() };
  const app = { setName: vi.fn(), commandLine: { appendSwitch: vi.fn() }, setPath: vi.fn(), getPath: vi.fn(),
    requestSingleInstanceLock: () => true, on: (name: string, fn: (...args: any[]) => void) => appEvents.set(name, fn),
    whenReady: async () => undefined, isPackaged: true, getVersion: () => "0.1.0", getAppPath: () => "/fixture/app",
    name: "Matrix OS", quit: vi.fn(), setBadgeCount: vi.fn(), setAsDefaultProtocolClient: () => true };
  class BrowserWindow {
    static getAllWindows() { return windows; }
    url = "";
    events = new Map<string, (...args: any[]) => void>();
    webContents = { session: targetSession, mainFrame: {}, getURL: () => this.url, isDestroyed: () => false,
      send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(), getZoomFactor: () => 1 };
    constructor(public options: unknown) { windows.push(this); }
    once(name: string, fn: (...args: any[]) => void) { this.events.set(name, fn); }
    on(name: string, fn: (...args: any[]) => void) { this.events.set(name, fn); }
    async loadFile(path: string) { this.url = `file://${path}`; }
    async loadURL(url: string) { this.url = new URL(url).toString(); }
    isDestroyed() { return false; }
    show() {} focus() {} isMinimized() { return false; }
  }
  return { ipc, windows, appEvents, targetSession, safeStorage, update, app, BrowserWindow, rejectProfileRead: false,
    menu: { buildFromTemplate: vi.fn((template: unknown) => template), setApplicationMenu: vi.fn() },
    openExternal: vi.fn(), dialog: { showMessageBox: vi.fn() } };
});

vi.mock("electron", () => ({ app: host.app, BrowserWindow: host.BrowserWindow, ipcMain: {
  handle: (channel: string, fn: any) => host.ipc.set(channel, fn) }, session: { defaultSession: host.targetSession },
  safeStorage: host.safeStorage, Menu: host.menu, shell: { openExternal: host.openExternal }, dialog: host.dialog,
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1512, height: 982 } }) },
  webContents: { fromId: vi.fn() }, Notification: { isSupported: () => false },
  clipboard: { availableFormats: () => [], readBuffer: () => Buffer.alloc(0) }, WebContentsView: class {} }));
vi.mock("electron-updater", () => ({ autoUpdater: host.update }));
vi.mock("../../desktop/src/main/persistence/local-store", async importOriginal => {
  const actual = await importOriginal<typeof import("../../desktop/src/main/persistence/local-store")>();
  return { ...actual, createLocalStore: (options: Parameters<typeof actual.createLocalStore>[0]) => {
    const store = actual.createLocalStore(options);
    return { ...store, get: async (key: Parameters<typeof store.get>[0]) => {
      if (host.rejectProfileRead && key === "profile") throw new Error("fixture local profile read failed");
      return store.get(key);
    } };
  } };
});
let directory: string;
const source = { commit: "a".repeat(40), ancestors: [] };
const fetch = vi.fn(() => { throw new Error("unexpected remote request"); });
function event() {
  const contents = host.windows[0]?.webContents;
  return { sender: contents, senderFrame: contents?.mainFrame };
}
function request(channel: string, payload: unknown = {}) {
  const handler = host.ipc.get(channel);
  if (!handler) throw new Error(`missing IPC ${channel}`);
  return handler(event(), payload);
}
async function boot({ mode }: { mode?: string } = { mode: "1" }) {
  vi.stubEnv("OPERATOR_DIAGNOSTIC_AUTH_ONLY", mode);
  await import("../../desktop/src/main/index");
  await vi.waitFor(() => expect(host.windows).toHaveLength(1));
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks(); host.ipc.clear(); host.windows.length = 0; host.appEvents.clear(); host.rejectProfileRead = false;
  directory = await mkdtemp(join(tmpdir(), "matrix-auth-diagnostic-test-"));
  host.app.getPath.mockImplementation(() => directory);
  host.safeStorage.decryptString.mockImplementation(b => b.toString());
  vi.stubGlobal("__dirname", "/fixture/out/main"); vi.stubGlobal("__MATRIX_DESKTOP_BUILD_SOURCE__", source);
  vi.stubGlobal("fetch", fetch); vi.stubEnv("ELECTRON_RENDERER_URL", "https://renderer.invalid");
  vi.stubEnv("OPERATOR_UPDATE_FEED", "https://updates.invalid");
  await writeFile(join(directory, "state.json"), JSON.stringify({ profile: {
    handle: "fixture", userId: "fixture-owner", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary" } }));
  await writeFile(join(directory, "credential.bin"), JSON.stringify({
    accessToken: "synthetic-fixture-only", expiresAt: Date.now() + 3600000, handle: "fixture", userId: "fixture-owner" }));
});
afterEach(async () => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true }); });

describe("actual trusted main diagnostic composition", () => {
  it("uses real auth/version and no normal services, remote renderer, update or browser over time", async () => {
    await boot();
    expect(await request("app:get-startup-mode")).toEqual({ mode: "auth-diagnostic" });
    expect(await request("auth:status")).toMatchObject({ signedIn: true, handle: "fixture", runtimeSlot: "primary" });
    expect(await request("app:get-version")).toEqual({ version: "0.1.0", source });
    expect([...host.ipc.keys()].sort()).toEqual(["app:get-startup-mode", "app:get-version", "auth:status", "update:check", "update:install"]);
    expect(new URL(host.windows[0].url).protocol).toBe("file:");
    expect(host.windows[0].url).toMatch(/\/renderer\/index.html$/);
    await vi.advanceTimersByTimeAsync(2 * 3600000);
    expect(fetch).not.toHaveBeenCalled(); expect(host.update.checkForUpdates).not.toHaveBeenCalled();
    expect(host.openExternal).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    await expect(request("update:check")).rejects.toThrow("Updates are unavailable in auth-only diagnostics.");
    await expect(request("update:install")).rejects.toThrow("Updates are unavailable in auth-only diagnostics.");
    const callback = host.targetSession.webRequest.onBeforeRequest.mock.calls[0]?.[1];
    expect(callback).toBeTypeOf("function");
    const answer = vi.fn(); callback({ url: "https://example.invalid" }, answer);
    expect(answer).toHaveBeenCalledWith({ cancel: true });
  });

  it("rejects another window, a subframe, invalid payload and navigated sender", async () => {
    await boot(); const handler = host.ipc.get("app:get-startup-mode")!;
    await expect(handler({ ...event(), sender: {} }, {})).rejects.toThrow("invalid request");
    await expect(handler({ ...event(), senderFrame: {} }, {})).rejects.toThrow("invalid request");
    await expect(request("app:get-startup-mode", { mode: "normal" })).rejects.toThrow("invalid request");
    host.windows[0].url = "https://other.invalid";
    await expect(handler(event(), {})).rejects.toThrow("invalid request");
  });

  it("reports actual expiry as signed out and retains normal expired-credential cleanup", async () => {
    await writeFile(join(directory, "credential.bin"), JSON.stringify({
      accessToken: "expired-fixture", expiresAt: Date.now() - 1, handle: "fixture", userId: "fixture-owner" }));
    await boot(); expect(await request("auth:status")).toMatchObject({ signedIn: false });
    await expect(access(join(directory, "credential.bin"))).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an actual OS decrypt failure as signed out without fabricating auth", async () => {
    host.safeStorage.decryptString.mockImplementation(() => { throw new Error("fixture keychain failure"); });
    await boot(); expect(await request("auth:status")).toMatchObject({ signedIn: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows initialization errors through status rejection while real version stays readable", async () => {
    host.rejectProfileRead = true; // Only the local read boundary rejects; real AuthService.init executes.
    await boot(); await expect(request("auth:status")).rejects.toThrow("Local auth status could not be read.");
    expect(await request("app:get-version")).toEqual({ version: "0.1.0", source });
  });

  it.each([undefined, "true", "0"])("preserves normal service wiring without exact opt-in %s", async mode => {
    await boot({ mode });
    expect(await request("app:get-startup-mode")).toEqual({ mode: "normal" });
    expect(host.ipc.has("chatgpt-plan:status")).toBe(true);
    expect(host.ipc.has("runtime:create-turn")).toBe(true);
    expect(host.windows[0].url).toBe("https://renderer.invalid/");
    const modeHandler = host.ipc.get("app:get-startup-mode")!;
    await expect(modeHandler({ ...event(), sender: {} }, {})).rejects.toThrow("invalid request");
    await expect(modeHandler({ ...event(), senderFrame: {} }, {})).rejects.toThrow("invalid request");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});
