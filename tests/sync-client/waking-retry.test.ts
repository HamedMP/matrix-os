import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createShellClient } from "../../packages/sync-client/src/cli/shell-client.js";
import { formatCliErrorMessage } from "../../packages/sync-client/src/cli/output.js";
import { fetchManifest } from "../../packages/sync-client/src/daemon/r2-client.js";
import { MAX_RUNTIME_WAKE_BODY_CHARS, readRuntimeWakeSignal } from "../../packages/contracts/src/runtime-lifecycle.js";

// The platform answers an owner request for a sleeping Matrix computer before
// proxying it: 503 + runtimeState + Retry-After (spec 2691, ENG-520).
function wakeResponse(body: Record<string, unknown>, retryAfter?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: {
      "content-type": "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    },
  });
}

const waking = () => wakeResponse({ error: "Matrix computer not ready", runtimeState: "waking" }, "3");
const busy = () => wakeResponse({ error: "Matrix computer not ready", runtimeState: "busy" }, "30");
const unavailable = () => wakeResponse({ error: "Matrix computer unavailable", code: "runtime_unavailable" });
const workspaces = () => new Response(JSON.stringify({ workspaces: [{ id: "main" }] }));

const TERMINAL_REF = {
  workspaceId: "tws_00000000000000000000000000000001",
  tabId: "tt_00000000000000000000000000000001",
} as const;

class ControlledWebSocket {
  static instances: ControlledWebSocket[] = [];
  static get last(): ControlledWebSocket | undefined {
    return ControlledWebSocket.instances.at(-1);
  }
  closed = false;
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  sent: string[] = [];

  constructor(public readonly url: string) {
    ControlledWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((existing) => existing !== listener));
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  /** What the `ws` package emits when the upgrade is answered with a non-101 status. */
  rejectUpgrade(status: number, headers: Record<string, string>, body: string) {
    const req = { destroy: vi.fn() };
    const res = Object.assign(new EventEmitter(), {
      statusCode: status,
      headers,
      resume: vi.fn(),
      destroy: vi.fn(),
      setEncoding: vi.fn(),
    });
    this.emit("unexpected-response", req, res);
    res.emit("data", Buffer.from(body));
    res.emit("end");
    return req;
  }
}

function serverFrame(type: "attached" | "exit", fields: Record<string, unknown> = {}): string {
  const defaults = type === "attached" ? { canonicalSize: { cols: 80, rows: 24 }, nextSeq: 0 } : { exitCode: 0 };
  return JSON.stringify({ type, terminalRef: TERMINAL_REF, revision: 1, ...defaults, ...fields });
}

describe("CLI waits for a waking Matrix computer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No jitter, so the schedule below is exact.
    vi.spyOn(Math, "random").mockReturnValue(0);
    ControlledWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a 503 with runtimeState waking after Retry-After, up to 30 s total", async () => {
    const calledAt: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calledAt.push(Date.now());
      return waking();
    });
    const startedAt = Date.now();
    const client = createShellClient({ gatewayUrl: "http://gateway", token: "tok", fetch: fetchImpl });

    const result = client.listWorkspaces().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await result as Error & { code?: string };
    expect(error.code).toBe("runtime_waking");
    expect(formatCliErrorMessage(error.code ?? "")).toMatch(/waking/i);
    expect(calledAt.at(-1)! - startedAt).toBeLessThanOrEqual(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it("resolves once the computer is awake and gives every attempt its own timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(workspaces());
    const client = createShellClient({ gatewayUrl: "http://gateway", token: "tok", fetch: fetchImpl });

    const result = client.listWorkspaces();
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toEqual([{ id: "main" }]);
    const signals = fetchImpl.mock.calls.map(([, init]) => init?.signal);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(3);
  });

  it("tells the user on stderr, once, when a wake takes longer than 3 s", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(workspaces());
    const client = createShellClient({ gatewayUrl: "http://gateway", fetch: fetchImpl });

    const result = client.listWorkspaces();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(stderr).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toEqual([{ id: "main" }]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith("Waking your Matrix computer…\n");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("writes nothing for a wake that finishes under 3 s", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const quickWake = wakeResponse({ runtimeState: "starting" }, "2");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(quickWake).mockResolvedValueOnce(workspaces());
    const client = createShellClient({ gatewayUrl: "http://gateway", fetch: fetchImpl });

    const result = client.listWorkspaces();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual([{ id: "main" }]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("does not retry a 503 runtime_unavailable more than once", async () => {
    const fetchImpl = vi.fn(async () => unavailable());
    const client = createShellClient({ gatewayUrl: "http://gateway", fetch: fetchImpl });

    const result = client.listWorkspaces().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(((await result) as { code?: string }).code).toBe("runtime_unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a busy runtime once, no sooner than Retry-After clamped to 10 s, then reports capacity", async () => {
    const fetchImpl = vi.fn(async () => busy());
    const client = createShellClient({ gatewayUrl: "http://gateway", fetch: fetchImpl });

    const result = client.listWorkspaces().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await result as { code?: string };
    expect(error.code).toBe("runtime_busy");
    expect(formatCliErrorMessage(error.code ?? "")).toMatch(/capacity/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a mutating request only when the platform answered with runtimeState", async () => {
    const tab = new Response(JSON.stringify({ tabId: "tt_1" }));
    const wakingFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(waking()).mockResolvedValueOnce(tab);
    const wakingClient = createShellClient({ gatewayUrl: "http://gateway", fetch: wakingFetch });
    const created = wakingClient.createTab("main", { name: "dev" });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(created).resolves.toEqual({ tabId: "tt_1" });
    expect(wakingFetch).toHaveBeenCalledTimes(2);

    const unavailableFetch = vi.fn(async () => unavailable());
    const unavailableClient = createShellClient({ gatewayUrl: "http://gateway", fetch: unavailableFetch });
    const failed = unavailableClient.createTab("main", { name: "dev" }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(((await failed) as { code?: string }).code).toBe("runtime_unavailable");
    expect(unavailableFetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay a mutation when the request times out without a wake response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    const client = createShellClient({ gatewayUrl: "http://gateway", fetch: fetchImpl });

    await expect(client.createTab("main", { name: "dev" })).rejects.toMatchObject({ code: "request_timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-wake 503 a plain failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>starting</html>", { status: 503 }));
    const client = createShellClient({ gatewayUrl: "http://gateway", fetch: fetchImpl });

    await expect(client.listWorkspaces()).rejects.toMatchObject({ code: "request_failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a terminal attach whose websocket upgrade was answered 503 waking", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 5_000 });
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const input = Object.assign(new EventEmitter(), { isTTY: false }) as unknown as NodeJS.ReadStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket as never,
      input,
      output,
      errorOutput,
    });
    const first = ControlledWebSocket.last!;
    const req = first.rejectUpgrade(503, { "retry-after": "3" }, JSON.stringify({ runtimeState: "waking" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(req.destroy).toHaveBeenCalled();
    expect(ControlledWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(ControlledWebSocket.instances).toHaveLength(2);
    const second = ControlledWebSocket.last!;
    second.emit("open");
    second.emit("message", serverFrame("attached"));
    second.emit("message", serverFrame("exit", { exitCode: 0 }));

    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
  });

  it("tells the user on stderr, once, when a refused terminal attach waits longer than 3 s", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 5_000 });
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorWrite = vi.fn();
    const errorOutput = { write: errorWrite } as unknown as NodeJS.WriteStream;
    const input = Object.assign(new EventEmitter(), { isTTY: false }) as unknown as NodeJS.ReadStream;
    const notices = () => errorWrite.mock.calls.filter(([text]) => String(text).includes("Waking your Matrix computer")).length;

    const attached = client.attachTab(TERMINAL_REF, { WebSocketImpl: ControlledWebSocket as never, input, output, errorOutput });
    for (let step = 0; step < 3; step += 1) {
      ControlledWebSocket.last!.rejectUpgrade(503, { "retry-after": "3" }, JSON.stringify({ runtimeState: "waking" }));
      await vi.advanceTimersByTimeAsync(step === 0 ? 2_999 : 3_000);
      if (step === 0) expect(notices()).toBe(0);
    }
    expect(notices()).toBe(1);
    const last = ControlledWebSocket.last!;
    last.emit("open");
    last.emit("message", serverFrame("attached"));
    last.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notices()).toBe(1);
  });

  it("writes no notice for a refused attach that wakes within 3 s", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 5_000 });
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorWrite = vi.fn();
    const errorOutput = { write: errorWrite } as unknown as NodeJS.WriteStream;
    const input = Object.assign(new EventEmitter(), { isTTY: false }) as unknown as NodeJS.ReadStream;

    const attached = client.attachTab(TERMINAL_REF, { WebSocketImpl: ControlledWebSocket as never, input, output, errorOutput });
    ControlledWebSocket.last!.rejectUpgrade(503, { "retry-after": "1" }, JSON.stringify({ runtimeState: "waking" }));
    await vi.advanceTimersByTimeAsync(1_000);
    const second = ControlledWebSocket.last!;
    second.emit("open");
    second.emit("message", serverFrame("attached"));
    second.emit("message", serverFrame("exit", { exitCode: 0 }));
    await expect(attached).resolves.toEqual({ detached: false, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errorWrite.mock.calls.some(([text]) => String(text).includes("Waking your Matrix computer"))).toBe(false);
  });

  it("fails a terminal attach with a typed code once the waking budget runs out", async () => {
    const client = createShellClient({ gatewayUrl: "http://gateway", timeoutMs: 5_000 });
    const output = { write: vi.fn(), columns: 80, rows: 24 } as unknown as NodeJS.WriteStream;
    const errorOutput = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const input = Object.assign(new EventEmitter(), { isTTY: false }) as unknown as NodeJS.ReadStream;

    const attached = client.attachTab(TERMINAL_REF, {
      WebSocketImpl: ControlledWebSocket as never,
      input,
      output,
      errorOutput,
    }).catch((err: unknown) => err);
    for (let step = 0; step < 20; step += 1) {
      ControlledWebSocket.last!.rejectUpgrade(503, { "retry-after": "3" }, JSON.stringify({ runtimeState: "waking" }));
      await vi.advanceTimersByTimeAsync(3_000);
    }

    expect(((await attached) as { code?: string }).code).toBe("runtime_waking");
    expect(ControlledWebSocket.instances).toHaveLength(11);
  });

  it("waits for a waking computer before reading the sync manifest", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: {} }), { headers: { etag: "\"v1\"" } }));

    const result = fetchManifest({ gatewayUrl: "http://gateway", token: "tok" });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toEqual({ manifest: { files: {} }, etag: "\"v1\"" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it("CLI and sync receive a wake refusal after the platform's 10-second wait", async () => {
  const requests = { POST: 0, GET: 0 };
  const server = createServer((request, response) => {
    request.resume();
    const writeJson = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(payload));
    };
    const method = request.method;
    if (method !== "POST" && method !== "GET") {
      writeJson(405, {});
      return;
    }
    requests[method]++;
    if (requests[method] === 1) {
      // The platform waits 10 seconds before returning its pre-proxy response.
      // Include a small margin for the request and response to travel.
      const timer = setTimeout(() => {
        writeJson(503, { runtimeState: "waking" }, { "Retry-After": "3" });
      }, 10_200);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    writeJson(200, method === "POST" ? { tabId: "tt_1" } : { files: {} });
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback listener");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const client = createShellClient({ gatewayUrl });

    const results = await Promise.allSettled([
      client.createTab("main", { name: "dev" }),
      fetchManifest({ gatewayUrl, token: "tok" }),
    ]);

    expect(results).toEqual([
      { status: "fulfilled", value: { tabId: "tt_1" } },
      { status: "fulfilled", value: { manifest: { files: {} }, etag: null } },
    ]);
    expect(requests).toEqual({ POST: 2, GET: 2 });
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}, 20_000);

it("keeps a non-interactive attach alive until it retries a wake refusal", async () => {
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  let attempts = 0;
  server.on("upgrade", (request, socket, head) => {
    attempts += 1;
    if (attempts === 1) {
      const body = JSON.stringify({ runtimeState: "waking" });
      socket.end([
        "HTTP/1.1 503 Service Unavailable",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Retry-After: 1",
        "Connection: close",
        "",
        body,
      ].join("\r\n"));
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      ws.send(serverFrame("attached"));
      ws.send(serverFrame("exit"), () => ws.close());
    });
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback listener");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const moduleUrl = new URL("../../packages/sync-client/src/cli/shell-client.ts", import.meta.url);
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { createShellClient } from ${JSON.stringify(moduleUrl.href)};
      const client = createShellClient({ gatewayUrl: ${JSON.stringify(gatewayUrl)} });
      client.attachTab(${JSON.stringify(TERMINAL_REF)}, { noRichPaste: true }).then(
        (result) => console.log("\\n" + JSON.stringify(result)),
        (error) => { console.error(error); process.exitCode = 1; },
      );
    `], { stdio: ["ignore", "pipe", "pipe"], timeout: 8_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [code, signal] = await once(child, "close");

    expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
    expect(attempts).toBe(2);
    expect(stdout.trim().split("\n").at(-1)).toBe(JSON.stringify({ detached: false, exitCode: 0 }));
  } finally {
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}, 10_000);

describe("wake response body limit", () => {
  function streamingResponse(chunkCount: number, headers: Record<string, string> = {}) {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1_024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > chunkCount) controller.close();
        else controller.enqueue(chunk);
      },
    });
    return { response: new Response(body, { status: 503, headers }), pulled: () => pulled };
  }

  it("stops reading a 503 body once it passes the wake body limit", async () => {
    const { response, pulled } = streamingResponse(1_000);
    await expect(readRuntimeWakeSignal(response)).resolves.toBeNull();
    // The cap is in bytes (4 per character at most); a cloned body may read a few chunks ahead.
    expect(pulled()).toBeLessThanOrEqual(Math.ceil((MAX_RUNTIME_WAKE_BODY_CHARS * 4) / 1_024) + 4);
    expect(pulled()).toBeLessThan(1_000);
  });

  it("does not read a 503 body whose Content-Length is over the limit", async () => {
    const { response, pulled } = streamingResponse(1_000, { "content-length": String(1_024 * 1_000) });
    await expect(readRuntimeWakeSignal(response)).resolves.toBeNull();
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("without response streams (React Native), checks the body size before turning it into text", async () => {
    const text = vi.fn(async () => "x".repeat(1_000_000));
    const blob = vi.fn(async () => ({ size: 1_000_000 }));
    const response = {
      status: 503,
      headers: { get: () => null },
      clone: () => ({ body: null, blob, text }),
    } as unknown as Response;
    await expect(readRuntimeWakeSignal(response)).resolves.toBeNull();
    expect(blob).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });

  it("still reads a small streamed wake body", async () => {
    const response = new Response(JSON.stringify({ runtimeState: "waking" }), { status: 503, headers: { "retry-after": "3" } });
    await expect(readRuntimeWakeSignal(response)).resolves.toMatchObject({ kind: "waking", retryAfterMs: 3_000 });
  });
});
