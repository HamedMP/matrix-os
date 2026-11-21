import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShellClient } from "../../packages/sync-client/src/cli/shell-client.js";
import { formatCliErrorMessage } from "../../packages/sync-client/src/cli/output.js";
import { fetchManifest } from "../../packages/sync-client/src/daemon/r2-client.js";

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
