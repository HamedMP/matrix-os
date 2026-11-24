import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_FILES_CHANNEL,
  APP_FILE_MAX_BYTES,
  APP_FILE_TIMEOUT_MS,
  appFileErrorBody,
  appFileVersion,
  encodeAppFileBase64,
} from "../../packages/contracts/src/app-files";
import { OPEN_REQUEST_KV_KEY } from "../../packages/contracts/src/office-open-with";
import { NativeAppBridge } from "../../desktop/src/main/embeds/native-app-bridge";
import { createNativeAppFilesRequester } from "../../desktop/src/main/embeds/native-app-files";
import {
  NATIVE_APP_OPEN_REQUEST_CHANNEL,
  createNativeAppFilesBridge,
  decodeNativeAppStoredValue,
  encodeNativeAppStoredValue,
} from "../../desktop/src/shared/native-app-files";

const electron = vi.hoisted(() => {
  let mainWorld: Record<string, unknown> = {};
  const exposeInMainWorld = vi.fn((name: string, value: unknown) => { mainWorld[name] = value; });
  const executeInMainWorld = vi.fn(({ func, args }: { func: (...args: unknown[]) => unknown; args: unknown[] }) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { value: mainWorld, configurable: true });
    try { return func(...args); }
    finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  return {
    contextBridge: { exposeInMainWorld, executeInMainWorld }, ipcRenderer: { invoke: vi.fn() },
    mainWorld: () => mainWorld, resetMainWorld: () => { mainWorld = {}; },
  };
});
vi.mock("electron", () => electron);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  electron.resetMainWorld();
});

const VERSION = appFileVersion(3, 1_700_000_000_000_000_000n);
const STAT = { path: "Documents/plan.docx", size: 3, modifiedAt: "2026-11-23T10:00:00.000Z", version: VERSION };

type Handler = (event: unknown, input: unknown) => Promise<unknown>;

function bridgeFixture(filesRequest = { files: vi.fn(async () => STAT as unknown), openRequest: vi.fn(async () => ({ value: null }) as unknown) }) {
  let generation = 0;
  const bridge = new NativeAppBridge({
    authGeneration: () => generation, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(),
    gatewayOrigin: () => "https://gateway.test", filesRequest,
  });
  bridge.register(7, "docs");
  const frame = {};
  const event = { senderFrame: frame, sender: { id: 7, mainFrame: frame, getURL: () => "https://gateway.test/apps/docs/", isDestroyed: () => false } };
  const handlers = new Map<string, Handler>();
  bridge.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) });
  return { bridge, event, filesRequest, files: handlers.get(APP_FILES_CHANNEL)!, openRequest: handlers.get(NATIVE_APP_OPEN_REQUEST_CHANNEL)!, bumpGeneration: () => generation++ };
}

describe("main process identity binding", () => {
  it("stamps the registered app identity and drops any app the view names", async () => {
    const f = bridgeFixture();
    await expect(f.files(f.event, { kind: "files.stat", path: "Documents/plan.docx" })).resolves.toEqual(STAT);
    expect(f.filesRequest.files).toHaveBeenCalledWith("docs", { kind: "files.stat", path: "Documents/plan.docx" }, expect.any(AbortSignal));
    await expect(f.files(f.event, { kind: "files.stat", path: "Documents/plan.docx", app: "mail" })).resolves.toEqual(appFileErrorBody("invalid_request"));
    expect(f.filesRequest.files).toHaveBeenCalledTimes(1);
  });

  it("refuses subframes, foreign documents, unregistered views and stale sign-ins", async () => {
    const f = bridgeFixture();
    const input = { kind: "files.read", path: "Documents/plan.docx" };
    const forbidden = appFileErrorBody("forbidden");
    await expect(f.files({ ...f.event, senderFrame: {} }, input)).resolves.toEqual(forbidden);
    await expect(f.files({ ...f.event, sender: { ...f.event.sender, getURL: () => "https://gateway.test/apps/mail/" } }, input)).resolves.toEqual(forbidden);
    await expect(f.files({ ...f.event, sender: { ...f.event.sender, getURL: () => "https://evil.test/apps/docs/" } }, input)).resolves.toEqual(forbidden);
    await expect(f.files({ ...f.event, sender: { ...f.event.sender, id: 8 } }, input)).resolves.toEqual(forbidden);
    f.bumpGeneration();
    await expect(f.files(f.event, input)).resolves.toEqual(forbidden);
    await expect(f.openRequest(f.event, { action: "read" })).rejects.toThrow("Open requests are unavailable");
    expect(f.filesRequest.files).not.toHaveBeenCalled();
    expect(f.filesRequest.openRequest).not.toHaveBeenCalled();
  });

  it("drops a reply that arrives after the view is unregistered", async () => {
    let finish!: (value: unknown) => void;
    const f = bridgeFixture({ files: vi.fn(() => new Promise((resolve) => { finish = resolve; })), openRequest: vi.fn() });
    const pending = f.files(f.event, { kind: "files.stat", path: "Documents/plan.docx" });
    await Promise.resolve();
    f.bridge.unregister(7);
    finish(STAT);
    await expect(pending).resolves.toEqual(appFileErrorBody("unavailable"));
  });

  it("caps concurrent file requests", async () => {
    const f = bridgeFixture({ files: vi.fn(() => new Promise(() => undefined)), openRequest: vi.fn() });
    for (let index = 0; index < 8; index++) void f.files(f.event, { kind: "files.stat", path: `a${index}` });
    await expect(f.files(f.event, { kind: "files.stat", path: "b" })).resolves.toEqual(appFileErrorBody("unavailable"));
    expect(f.filesRequest.files).toHaveBeenCalledTimes(8);
  });

  it("reads and clears only the open request key of the bound app", async () => {
    const f = bridgeFixture();
    await expect(f.openRequest(f.event, { action: "read" })).resolves.toEqual({ value: null });
    await f.openRequest(f.event, { action: "clear" });
    expect(f.filesRequest.openRequest).toHaveBeenNthCalledWith(1, "docs", { action: "read" }, expect.any(AbortSignal));
    expect(f.filesRequest.openRequest).toHaveBeenNthCalledWith(2, "docs", { action: "clear" }, expect.any(AbortSignal));
    await expect(f.openRequest(f.event, { action: "write", key: "other", value: "x" })).rejects.toThrow("Open requests are unavailable");
    expect(f.filesRequest.openRequest).toHaveBeenCalledTimes(2);
  });
});

describe("main process gateway transport", () => {
  const options = (fetchFn: typeof fetch) => ({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "owner-secret", fetchFn });

  it("posts { app, input } with the owner credential", async () => {
    const fetchFn = vi.fn(async () => Response.json(STAT));
    const requester = createNativeAppFilesRequester(options(fetchFn as never));
    await expect(requester.files("docs", { kind: "files.stat", path: "Documents/plan.docx" })).resolves.toEqual(STAT);
    expect(fetchFn).toHaveBeenCalledWith("https://gateway.test/api/bridge/files", expect.objectContaining({
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ app: "docs", input: { kind: "files.stat", path: "Documents/plan.docx" } }),
    }));
  });

  it("gives up after the file timeout, not the shorter capability timeout", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    let settled: unknown = "pending";
    void createNativeAppFilesRequester(options(fetchFn as never)).files("docs", { kind: "files.read", path: "a.docx" }).then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(APP_FILE_TIMEOUT_MS - 30_000 + 1);
    expect(settled).toEqual(appFileErrorBody("unavailable"));
  });

  it("passes contract error bodies through and maps other failures to fixed codes", async () => {
    const reply = (response: Response) => createNativeAppFilesRequester(options(vi.fn(async () => response) as never))
      .files("docs", { kind: "files.read", path: "a.docx" });
    await expect(reply(Response.json(appFileErrorBody("version_conflict"), { status: 409 }))).resolves.toEqual(appFileErrorBody("version_conflict"));
    await expect(reply(Response.json({ error: "/home/matrix/secret ENOENT" }, { status: 404 }))).resolves.toEqual(appFileErrorBody("not_found"));
    await expect(reply(new Response("oops", { status: 500 }))).resolves.toEqual(appFileErrorBody("unavailable"));
    await expect(reply(Response.json({ path: "a.docx" }))).resolves.toEqual(appFileErrorBody("unavailable"));
    const failing = createNativeAppFilesRequester(options(vi.fn(async () => { throw new Error("ECONNREFUSED 10.0.0.1"); }) as never));
    await expect(failing.files("docs", { kind: "files.stat", path: "a" })).resolves.toEqual(appFileErrorBody("unavailable"));
    const signedOut = createNativeAppFilesRequester({ ...options(vi.fn() as never), getToken: () => null });
    await expect(signedOut.files("docs", { kind: "files.stat", path: "a" })).resolves.toEqual(appFileErrorBody("unavailable"));
  });

  it("allows a 10 MiB read reply but keeps other kinds at the small reply cap", async () => {
    const bytes = new Uint8Array(APP_FILE_MAX_BYTES);
    const read = { path: "big.docx", contentBase64: encodeAppFileBase64(bytes), size: bytes.length, version: VERSION, mimeType: "application/octet-stream" };
    const readRequester = createNativeAppFilesRequester(options(vi.fn(async () => Response.json(read)) as never));
    await expect(readRequester.files("docs", { kind: "files.read", path: "big.docx" })).resolves.toMatchObject({ size: APP_FILE_MAX_BYTES });
    const padded = { ...STAT, path: `${"d/".repeat(1000)}x` };
    const huge = new Response(JSON.stringify(padded) + " ".repeat(300 * 1024), { headers: { "content-type": "application/json" } });
    const statRequester = createNativeAppFilesRequester(options(vi.fn(async () => huge) as never));
    await expect(statRequester.files("docs", { kind: "files.stat", path: "x" })).resolves.toEqual(appFileErrorBody("unavailable"));
  });

  it("reads and clears the open request through the key-value route", async () => {
    const request = { path: "Documents/plan.docx", requestedAt: "2026-11-23T10:00:00.000Z", nonce: "nonce-1234" };
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).action === "read"
      ? Response.json({ value: encodeNativeAppStoredValue(request) }) : Response.json({ ok: true }));
    const requester = createNativeAppFilesRequester(options(fetchFn as never));
    await expect(requester.openRequest("docs", { action: "read" })).resolves.toEqual({ value: request });
    await expect(requester.openRequest("docs", { action: "clear" })).resolves.toEqual({ ok: true });
    expect(fetchFn.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body))])).toEqual([
      ["https://gateway.test/api/bridge/data", { action: "read", app: "docs", key: OPEN_REQUEST_KV_KEY }],
      ["https://gateway.test/api/bridge/data", { action: "write", app: "docs", key: OPEN_REQUEST_KV_KEY, value: encodeNativeAppStoredValue(null) }],
    ]);
  });
});

describe("stored value envelope", () => {
  it("round-trips the shell key-value encoding", () => {
    expect(encodeNativeAppStoredValue({ a: 1 })).toBe("__matrix_os_value_v1__:{\"value\":{\"a\":1}}");
    expect(decodeNativeAppStoredValue(encodeNativeAppStoredValue(null))).toBeNull();
    expect(decodeNativeAppStoredValue("plain")).toBe("plain");
    expect(decodeNativeAppStoredValue("__matrix_os_value_v1__:{bad")).toBe("__matrix_os_value_v1__:{bad");
  });
});

describe("preload files bridge", () => {
  function preloadFixture(reply: unknown) {
    const invokeFiles = vi.fn(async () => reply);
    const store: { value: unknown } = { value: null };
    const invokeOpenRequest = vi.fn(async (request: { action: string }) => {
      if (request.action === "read") return { value: store.value };
      store.value = null;
      return { ok: true };
    });
    let trigger: (() => void) | null = null;
    const files = createNativeAppFilesBridge({ invokeFiles, invokeOpenRequest, watchOpenRequests: (check) => { trigger = check; return () => { trigger = null; }; } });
    return { files, invokeFiles, invokeOpenRequest, store, fire: () => trigger?.() };
  }

  it("returns result values instead of throwing, with fixed messages", async () => {
    const ok = preloadFixture(STAT);
    await expect(ok.files.stat("Documents/plan.docx")).resolves.toEqual({ ok: true, value: STAT });
    const conflict = preloadFixture(appFileErrorBody("version_conflict"));
    await expect(conflict.files.write("a.docx", new Uint8Array([1]), { ifVersion: VERSION })).resolves.toEqual({ ok: false, code: "version_conflict", message: "File changed since it was opened" });
    await expect(conflict.files.read("../etc/passwd")).resolves.toEqual({ ok: false, code: "invalid_request", message: "Invalid file request" });
    await expect(conflict.files.write("a.docx", new Uint8Array(APP_FILE_MAX_BYTES + 1), { ifVersion: null })).resolves.toMatchObject({ ok: false, code: "too_large" });
    expect(conflict.invokeFiles).toHaveBeenCalledTimes(1);
  });

  it("delivers an open request once, clears it, and drops stale requests", async () => {
    const f = preloadFixture(null);
    const request = { path: "Documents/plan.docx", requestedAt: new Date().toISOString(), nonce: "nonce-abcdef" };
    f.store.value = request;
    await expect(f.files.openRequest()).resolves.toEqual(request);
    await vi.waitFor(() => expect(f.store.value).toBeNull());
    f.store.value = request;
    await expect(f.files.openRequest()).resolves.toBeNull();
    f.store.value = { ...request, nonce: "nonce-stale1", requestedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
    await expect(f.files.openRequest()).resolves.toBeNull();
  });

  it("notifies running apps when a new request arrives", async () => {
    const f = preloadFixture(null);
    const seen: unknown[] = [];
    const stop = f.files.onOpenRequest((request) => seen.push(request));
    const request = { path: "Sheets/q4.xlsx", requestedAt: new Date().toISOString(), nonce: "nonce-sheet1" };
    f.store.value = request;
    f.fire();
    await vi.waitFor(() => expect(seen).toEqual([request]));
    f.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(1);
    stop();
  });
});

describe("preload exposure", () => {
  it("exposes files and throws BridgeFileError with a code in the page world", async () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
    electron.ipcRenderer.invoke.mockImplementation(async (channel: string) => channel === APP_FILES_CHANNEL ? appFileErrorBody("forbidden") : null);
    vi.resetModules();
    await import("../../desktop/src/preload/index.js");
    const api = electron.mainWorld().MatrixOS as { files: Record<string, (...args: unknown[]) => Promise<unknown>> };
    expect(Object.keys(api.files).sort()).toEqual(["list", "mkdir", "onOpenRequest", "openRequest", "read", "stat", "write"]);
    const error = await api.files.read("Documents/plan.docx").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "BridgeFileError", code: "forbidden", message: "File access is not allowed" });
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(APP_FILES_CHANNEL, { kind: "files.read", path: "Documents/plan.docx" });
    await expect(api.files.openRequest()).resolves.toBeNull();
  });
});
