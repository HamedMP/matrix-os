import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_FILE_MAX_BYTES,
  APP_FILE_TIMEOUT_MS,
  APP_FILES_BRIDGE_PATH,
  MAX_APP_FILE_LIST_REPLY_BYTES,
  MAX_APP_FILE_REPLY_BYTES,
  MAX_APP_FILE_REQUEST_BYTES,
  appFileErrorBody,
  encodeAppFileBase64,
} from "../../packages/contracts/src/app-files";
import { MAX_APP_BRIDGE_REPLY_BYTES, MAX_APP_CAPABILITY_BYTES } from "../../packages/contracts/src/app-capabilities";
import { buildBridgeScript, encodeBridgeStoredValue } from "../../shell/src/lib/os-bridge";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
import { appBridgeTimeoutMs, prepareAppBridgeFetch, readAppBridgeResponse } from "../../shell/src/components/app-capability-request";
import { prepareBridgeFetchRequest } from "../../shell/src/components/app-viewer-bridge-request";

const VERSION = "v1.a.b";
const MODIFIED = "2026-11-22T10:00:00.000Z";

interface FileError { name: string; code: string; message: string }
interface TestFiles {
  list(dir: string, options?: { limit?: number }): Promise<unknown>;
  stat(path: string): Promise<unknown>;
  read(path: string): Promise<{ path: string; bytes: Uint8Array; size: number; version: string; mimeType: string }>;
  write(path: string, bytes: Uint8Array, options: unknown): Promise<unknown>;
  mkdir(path: string): Promise<unknown>;
  openRequest(): Promise<unknown>;
  onOpenRequest(callback: (request: unknown) => void): () => void;
}
interface Frame { type: string; app: string; payload: { url?: string; init?: { method: string; body: string }; key?: string; value?: string } }
type Reply = (data: unknown) => void;

/**
 * Runs the real injected script in a VM and plays the trusted parent: every
 * bridge fetch goes through the same prepare/read helpers AppViewer uses, and
 * `gateway` answers like the route.
 */
function mountBridge(appName: string, gateway: (bound: { url: string; init: RequestInit }) => { status: number; body: unknown } | null) {
  const frames: Frame[] = [];
  const sentToGateway: Array<{ url: string; init: RequestInit }> = [];
  /** What the parent rejected, as AppViewer does: the app only sees a generic error. */
  const hostErrors: unknown[] = [];
  const kv = new Map<string, string>();
  const listeners: Array<(event: { data: unknown; source?: unknown }) => void> = [];
  class Channel {
    port1 = { close: vi.fn(), onmessage: undefined as undefined | ((event: { data: unknown }) => void) };
    port2 = { reply: ((data: unknown) => this.port1.onmessage?.({ data })) as Reply };
  }
  const window = {
    MatrixOS: undefined as undefined | { files: TestFiles; app: { name: string } },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === "message") listeners.push(listener); },
    parent: {
      postMessage(message: Frame, _origin: string, ports?: Channel["port2"][]) {
        frames.push(message);
        const port = ports?.[0];
        if (!port) return;
        if (message.type === "os:read-data") { port.reply({ ok: true, value: kv.get(message.payload.key!) ?? null }); return; }
        if (message.type === "os:write-data") { kv.set(message.payload.key!, message.payload.value!); port.reply({ ok: true }); return; }
        if (message.type !== "os:bridge-fetch") return;
        void (async () => {
          try {
            const bound = prepareBridgeFetchRequest(message.app, message.payload);
            sentToGateway.push(bound);
            const answer = gateway(bound);
            if (!answer) return;
            const response = new Response(JSON.stringify(answer.body), { status: answer.status });
            const body = await readAppBridgeResponse(response, bound);
            port.reply({ ok: response.ok, status: response.status, body: response.ok ? body : null });
          } catch (error: unknown) {
            hostErrors.push(error);
            port.reply({ ok: false, error: "App request unavailable" });
          }
        })();
      },
    },
  };
  runInNewContext(buildBridgeScript(appName), {
    window, document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild: vi.fn() } },
    MessageChannel: Channel, setTimeout, clearTimeout, console, Uint8Array, atob, btoa, Date, Error, Object, JSON, Promise,
  });
  const dataChange = (key: string, app: string) => listeners.forEach((listener) => listener({ data: { type: "os:data-change", payload: { key, app } } }));
  return { files: window.MatrixOS!.files, frames, sentToGateway, hostErrors, kv, dataChange };
}

async function rejection(promise: Promise<unknown>): Promise<FileError> {
  try { await promise; } catch (error) { return error as FileError; }
  throw new Error("expected a rejection");
}

describe("bridge allowlist and limits for app files", () => {
  it("allows exactly POST /api/bridge/files and nothing below or beside it", () => {
    expect(isAllowedBridgeFetchUrl("docs", APP_FILES_BRIDGE_PATH, "POST")).toBe(true);
    for (const url of ["/api/bridge/files/read", "/api/bridge/files?path=a", "/api/bridge/files#x", "/api/bridge/files%2Fread", "/api/bridge//files"]) {
      expect(isAllowedBridgeFetchUrl("docs", url, "POST"), url).toBe(false);
    }
    expect(() => prepareBridgeFetchRequest("docs", { url: APP_FILES_BRIDGE_PATH, init: { method: "GET" } })).toThrow();
  });

  it("applies the large request cap only to a write and the small cap to every other kind", () => {
    const bigRead = JSON.stringify({ kind: "files.read", path: "a".repeat(4000), pad: "x".repeat(MAX_APP_CAPABILITY_BYTES) });
    expect(() => prepareAppBridgeFetch("docs", APP_FILES_BRIDGE_PATH, { method: "POST", body: bigRead })).toThrow();
    const content = encodeAppFileBase64(new Uint8Array(APP_FILE_MAX_BYTES));
    const write = prepareAppBridgeFetch("docs", APP_FILES_BRIDGE_PATH, { method: "POST", body: JSON.stringify({ kind: "files.write", path: "a.docx", contentBase64: content, ifVersion: null }) });
    expect(JSON.parse(write.init.body as string).input.contentBase64).toHaveLength(content.length);
    const over = JSON.stringify({ kind: "files.write", path: "a.docx", contentBase64: content + "AAAA", ifVersion: null });
    expect(() => prepareAppBridgeFetch("docs", APP_FILES_BRIDGE_PATH, { method: "POST", body: over })).toThrow();
    expect(() => prepareAppBridgeFetch("docs", APP_FILES_BRIDGE_PATH, { method: "POST", body: "x".repeat(MAX_APP_FILE_REQUEST_BYTES + 1) })).toThrow();
    // The large cap stays on this route: other routes keep their own limits.
    expect(() => prepareAppBridgeFetch("docs", "/api/bridge/capabilities", { method: "POST", body: JSON.stringify({ kind: "capabilities", pad: "x".repeat(MAX_APP_CAPABILITY_BYTES) }) })).toThrow();
  });

  it("bounds the reply by kind and uses the file timeout for this route only", async () => {
    const bound = (input: object) => prepareAppBridgeFetch("docs", APP_FILES_BRIDGE_PATH, { method: "POST", body: JSON.stringify(input) });
    const padded = (bytes: number) => new Response(JSON.stringify({ pad: "x".repeat(bytes) }), { status: 200 });
    await expect(readAppBridgeResponse(padded(MAX_APP_BRIDGE_REPLY_BYTES), bound({ kind: "files.stat", path: "a.docx" }))).rejects.toThrow();
    await expect(readAppBridgeResponse(padded(MAX_APP_FILE_LIST_REPLY_BYTES), bound({ kind: "files.list", dir: "" }))).rejects.toThrow();
    await expect(readAppBridgeResponse(padded(MAX_APP_FILE_REPLY_BYTES), bound({ kind: "files.read", path: "a.docx" }))).rejects.toThrow();
    // A read reply larger than every other cap but within the read cap is accepted.
    const bytes = new Uint8Array(9 * 1024 * 1024).fill(65);
    const reply = { path: "a.docx", contentBase64: encodeAppFileBase64(bytes), size: bytes.length, version: VERSION, mimeType: "application/octet-stream" };
    await expect(readAppBridgeResponse(new Response(JSON.stringify(reply)), bound({ kind: "files.read", path: "a.docx" }))).resolves.toMatchObject({ size: bytes.length });
    // A reply that does not match the kind's schema never reaches the app.
    await expect(readAppBridgeResponse(new Response(JSON.stringify({ path: "a.docx" })), bound({ kind: "files.stat", path: "a.docx" }))).rejects.toThrow();
    expect(appBridgeTimeoutMs(APP_FILES_BRIDGE_PATH)).toBe(APP_FILE_TIMEOUT_MS);
    expect(appBridgeTimeoutMs("/api/bridge/data")).toBe(10_000);
  });
});

describe("identity binding", () => {
  it("binds the trusted app and drops an app name supplied by the iframe", () => {
    const bound = prepareAppBridgeFetch("docs", APP_FILES_BRIDGE_PATH, { method: "POST", body: JSON.stringify({ app: "mail", kind: "files.read", path: "a.docx" }) });
    expect(JSON.parse(bound.init.body as string)).toEqual({ app: "docs", input: { kind: "files.read", path: "a.docx" } });
    expect(() => prepareAppBridgeFetch("docs", APP_FILES_BRIDGE_PATH, { method: "POST", body: JSON.stringify({ kind: "files.read", path: "a.docx", input: { app: "mail" } }) })).toThrow();
    expect(() => prepareAppBridgeFetch("not a valid identity!", APP_FILES_BRIDGE_PATH, { method: "POST", body: JSON.stringify({ kind: "files.stat", path: "a" }) })).toThrow();
  });

  it("sends requests from the injected script under the frame's own identity", async () => {
    const bridge = mountBridge("docs", () => ({ status: 200, body: { path: "a.docx", size: 1, modifiedAt: MODIFIED, version: VERSION } }));
    await bridge.files.stat("a.docx");
    expect(JSON.parse(bridge.sentToGateway[0]!.init.body as string)).toEqual({ app: "docs", input: { kind: "files.stat", path: "a.docx" } });
  });
});

describe("MatrixOS.files in the injected bridge", () => {
  it("round-trips arbitrary binary bytes through write and read", async () => {
    const bytes = new Uint8Array(70_000);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 131 + 7) & 255;
    let stored = "";
    const bridge = mountBridge("docs", (bound) => {
      const { input } = JSON.parse(bound.init.body as string);
      if (input.kind === "files.write") {
        stored = input.contentBase64;
        return { status: 200, body: { path: input.path, version: VERSION, size: bytes.length, modifiedAt: MODIFIED } };
      }
      return { status: 200, body: { path: input.path, contentBase64: stored, size: bytes.length, version: VERSION, mimeType: "application/octet-stream" } };
    });
    await expect(bridge.files.write("Documents/a.docx", bytes, { ifVersion: null, createParents: true })).resolves.toEqual({ path: "Documents/a.docx", version: VERSION, size: bytes.length, modifiedAt: MODIFIED });
    expect(stored).toBe(encodeAppFileBase64(bytes));
    expect(JSON.parse(bridge.sentToGateway[0]!.init.body as string).input).toMatchObject({ ifVersion: null, createParents: true });
    const read = await bridge.files.read("Documents/a.docx");
    expect(read.bytes.constructor.name).toBe("Uint8Array");
    expect(Array.from(read.bytes)).toEqual(Array.from(bytes));
    expect(read).toMatchObject({ path: "Documents/a.docx", size: bytes.length, version: VERSION, mimeType: "application/octet-stream" });
  });

  it("lists, stats and creates directories with the contract inputs", async () => {
    const bridge = mountBridge("sheets", (bound) => {
      const { input } = JSON.parse(bound.init.body as string);
      if (input.kind === "files.list") return { status: 200, body: { entries: [{ name: "a.csv", path: "a.csv", kind: "file", size: 3, modifiedAt: MODIFIED }], truncated: false } };
      return { status: 200, body: { path: input.path } };
    });
    await expect(bridge.files.list("", { limit: 10 })).resolves.toMatchObject({ entries: [{ name: "a.csv" }], truncated: false });
    await expect(bridge.files.mkdir("Sheets/New")).resolves.toEqual({ path: "Sheets/New" });
    expect(bridge.sentToGateway.map((bound) => JSON.parse(bound.init.body as string).input)).toEqual([
      { kind: "files.list", dir: "", limit: 10 },
      { kind: "files.mkdir", path: "Sheets/New" },
    ]);
  });

  it("rejects with a typed BridgeFileError carrying the gateway code and fixed message", async () => {
    let status = 409;
    const bridge = mountBridge("docs", () => ({ status, body: appFileErrorBody(status === 409 ? "version_conflict" : "not_found") }));
    const conflict = await rejection(bridge.files.write("a.docx", new Uint8Array([1]), { ifVersion: VERSION }));
    expect(conflict).toMatchObject({ name: "BridgeFileError", code: "version_conflict", message: "File changed since it was opened" });
    status = 404;
    expect(await rejection(bridge.files.read("a.docx"))).toMatchObject({ name: "BridgeFileError", code: "not_found", message: "File not found" });
    status = 500;
    expect(await rejection(bridge.files.stat("a.docx"))).toMatchObject({ name: "BridgeFileError", code: "unavailable" });
  });

  it("refuses invalid input and oversized content in the frame without contacting the parent", async () => {
    const bridge = mountBridge("docs", () => ({ status: 200, body: {} }));
    expect(await rejection(bridge.files.read("../etc/passwd"))).toMatchObject({ name: "BridgeFileError", code: "invalid_request" });
    expect(await rejection(bridge.files.list("", { limit: 0 }))).toMatchObject({ code: "invalid_request" });
    expect(await rejection(bridge.files.write("a.docx", "text" as unknown as Uint8Array, { ifVersion: null }))).toMatchObject({ code: "invalid_request" });
    expect(await rejection(bridge.files.write("a.docx", new Uint8Array(1), {}))).toMatchObject({ code: "invalid_request" });
    expect(await rejection(bridge.files.write("a.docx", new Uint8Array(APP_FILE_MAX_BYTES + 1), { ifVersion: null }))).toMatchObject({ code: "too_large" });
    expect(bridge.frames.filter((frame) => frame.type === "os:bridge-fetch")).toHaveLength(0);
  });

  it("fails as unavailable when the parent does not answer within the file budget", async () => {
    vi.useFakeTimers();
    try {
      const bridge = mountBridge("docs", () => null);
      let settled: FileError | null = null;
      void bridge.files.stat("a.docx").catch((error: FileError) => { settled = error; });
      await vi.advanceTimersByTimeAsync(APP_FILE_TIMEOUT_MS - 1);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toMatchObject({ name: "BridgeFileError", code: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("open requests in the injected bridge", () => {
  afterEach(() => vi.useRealTimers());
  const request = (nonce: string, requestedAt = new Date().toISOString()) => ({ path: "Documents/a.docx", requestedAt, nonce });

  it("reads the pending request once and clears the key", async () => {
    const bridge = mountBridge("docs", () => ({ status: 200, body: {} }));
    const pending = request("nonce-0001");
    bridge.kv.set("open-request", encodeBridgeStoredValue(pending));
    await expect(bridge.files.openRequest()).resolves.toEqual(pending);
    expect(bridge.kv.get("open-request")).toBe(encodeBridgeStoredValue(null));
    await expect(bridge.files.openRequest()).resolves.toBeNull();
  });

  it("drops stale and malformed requests but still clears them", async () => {
    const bridge = mountBridge("docs", () => ({ status: 200, body: {} }));
    bridge.kv.set("open-request", encodeBridgeStoredValue(request("nonce-0002", new Date(Date.now() - 11 * 60_000).toISOString())));
    await expect(bridge.files.openRequest()).resolves.toBeNull();
    expect(bridge.kv.get("open-request")).toBe(encodeBridgeStoredValue(null));
    bridge.kv.set("open-request", encodeBridgeStoredValue({ ...request("nonce-0003"), extra: true }));
    await expect(bridge.files.openRequest()).resolves.toBeNull();
    bridge.kv.set("open-request", encodeBridgeStoredValue({ ...request("nonce-0004"), path: "../a.docx" }));
    await expect(bridge.files.openRequest()).resolves.toBeNull();
  });

  it("delivers a request that arrives while running, once per nonce, for this app only", async () => {
    const bridge = mountBridge("docs", () => ({ status: 200, body: {} }));
    const received: unknown[] = [];
    const unsubscribe = bridge.files.onOpenRequest((value) => received.push(value));
    const first = request("nonce-0005");
    bridge.kv.set("open-request", encodeBridgeStoredValue(first));
    bridge.dataChange("open-request", "sheets");
    bridge.dataChange("other-key", "docs");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
    bridge.dataChange("open-request", "docs");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([first]);
    // The same nonce written again is not delivered twice.
    bridge.kv.set("open-request", encodeBridgeStoredValue(first));
    bridge.dataChange("open-request", "docs");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
    unsubscribe();
    bridge.kv.set("open-request", encodeBridgeStoredValue(request("nonce-0006")));
    bridge.dataChange("open-request", "docs");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
  });

  it("caps open-request listeners", () => {
    const bridge = mountBridge("docs", () => ({ status: 200, body: {} }));
    for (let index = 0; index < 32; index++) bridge.files.onOpenRequest(() => undefined);
    expect(() => bridge.files.onOpenRequest(() => undefined)).toThrow();
  });
});
