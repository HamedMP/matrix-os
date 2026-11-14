import { afterEach, expect, it, vi } from "vitest";
import { executeRoutineOperation } from "../../packages/sync-client/src/cli/routine-client.js";
import type { RoutineCliOperation } from "@matrix-os/contracts/routine-cli";
import { EventEmitter, getEventListeners } from "node:events";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const LIST = { operation: "list" } as const;
const RESULT = { kind: "list", routines: [], truncated: false } as const;

it.each(["success", "abort"])("source client works without AbortSignal.any on the Node >=20 public API boundary: %s", async outcome => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
  const messages = process.listenerCount("message"), disconnects = process.listenerCount("disconnect");
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  Object.defineProperty(process, "send", { configurable: true, value: vi.fn((_frame, callback) => {
    queueMicrotask(() => { callback?.(null); process.emit("message", { v: 1, type: "routine.capability",
      endpoint: "http://127.0.0.1:1/api/routine-cli/execute", token: "rcli_" + "A".repeat(43) }); }); return true;
  }) });
  const controller = new AbortController(), deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (outcome === "abort") {
      const pending = new Promise<Response>((_done, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      controller.abort(); return pending;
    }
    return new Response(JSON.stringify({ v: 1, ok: true, data: RESULT }));
  });
  vi.stubGlobal("fetch", fetch);
  try {
    if (outcome === "abort") await expect(executeRoutineOperation({ operation: "pause", routineId: "rt_" + "a".repeat(24), baseRevision: 1,
      requestId: "de000000-0000-4000-8000-000000000100" }, controller.signal)).resolves.toMatchObject({ kind: "unknown", requestId: "de000000-0000-4000-8000-000000000100" });
    else expect(await executeRoutineOperation(LIST, controller.signal)).toEqual(RESULT);
    expect(timeout).toHaveBeenCalledTimes(outcome === "abort" ? 2 : 1);
    expect(timeout).toHaveBeenLastCalledWith(outcome === "abort" ? 10_000 : 30_000);
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
    expect(fetch).toHaveBeenCalledOnce(); expect(process.send).toHaveBeenCalledOnce();
    expect(process.listenerCount("message")).toBe(messages); expect(process.listenerCount("disconnect")).toBe(disconnects);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    Object.defineProperty(AbortSignal, "any", any);
    if (send) Object.defineProperty(process, "send", send); else delete process.send;
    if (connected) Object.defineProperty(process, "connected", connected); else delete (process as Partial<NodeJS.Process>).connected;
  }
});

const REQUEST = "de000000-0000-4000-8000-000000000100";
const PAUSE = { operation: "pause", routineId: "rt_" + "a".repeat(24), baseRevision: 1, requestId: REQUEST } as const;
const RECEIPT = { kind: "receipt", receipt: { requestId: REQUEST, operation: "pause", disposition: "applied",
  routine: { routineId: PAUSE.routineId, status: "paused", revision: 2 }, revision: 1, createdAt: "2026-09-27T12:00:00.000Z" }, current: null, approval: null } as const;
const CAPABILITY = { v: 1, type: "routine.capability", endpoint: "http://127.0.0.1:1/api/routine-cli/execute", token: "rcli_" + "A".repeat(43) };

/** Replace only the process transport and HTTP peer; exercise the production client and its actual timers. */
function waitingClient(operation: RoutineCliOperation = PAUSE, holdHttp = false) {
  const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
  const messages = process.listenerCount("message"), disconnects = process.listenerCount("disconnect");
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  Object.defineProperty(process, "send", { configurable: true, value: vi.fn((_frame, callback) => { callback?.(null); return true; }) });
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), ms);
    return deadline.signal;
  });
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (holdHttp) return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    return new Response(JSON.stringify({ v: 1, ok: true, data: operation.operation === "list" ? RESULT : RECEIPT }));
  });
  vi.stubGlobal("fetch", fetch);
  // Vitest uses this worker's real process IPC. Isolate that transport so its
  // own heartbeat frames cannot masquerade as malformed host capabilities.
  const ipc = new EventEmitter(), originalOn = process.on.bind(process), originalOnce = process.once.bind(process), originalRemove = process.removeListener.bind(process);
  const on = vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "message" || event === "disconnect") { ipc.on(event, listener); return process; }
    return originalOn(event, listener);
  });
  const once = vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "message" || event === "disconnect") { ipc.once(event, listener); return process; }
    return originalOnce(event, listener);
  });
  const remove = vi.spyOn(process, "removeListener").mockImplementation((event, listener) => {
    if (event === "message" || event === "disconnect") { ipc.removeListener(event, listener); return process; }
    return originalRemove(event, listener);
  });
  let settled = false;
  const result = executeRoutineOperation(operation, controller.signal);
  const drained = result.then(() => { settled = true; }, () => { settled = true; });
  return { controller, fetch, result, settled: () => settled,
    frame: (value: unknown) => ipc.emit("message", value), disconnect: () => ipc.emit("disconnect"),
    close: async () => {
      controller.abort(); await drained; on.mockRestore(); once.mockRestore(); remove.mockRestore();
      expect(ipc.listenerCount("message")).toBe(0); expect(ipc.listenerCount("disconnect")).toBe(0);
      expect(process.listenerCount("message")).toBe(messages); expect(process.listenerCount("disconnect")).toBe(disconnects);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      if (send) Object.defineProperty(process, "send", send); else delete process.send;
      if (connected) Object.defineProperty(process, "connected", connected); else delete (process as Partial<NodeJS.Process>).connected;
    },
  };
}

it("waits beyond the previous two-minute ceiling for an owner decision without sending a request before capability", async () => {
  vi.useFakeTimers(); const cli = waitingClient();
  try {
    await vi.advanceTimersByTimeAsync(120_001);
    expect(cli.settled()).toBe(false); expect(cli.fetch).not.toHaveBeenCalled();
    cli.frame(CAPABILITY);
    expect(await cli.result).toEqual(RECEIPT); expect(cli.fetch).toHaveBeenCalledOnce();
  } finally { await cli.close(); }
});

it("bounds the owner wait and ignores a capability delivered after its deadline", async () => {
  vi.useFakeTimers(); const cli = waitingClient();
  try {
    await vi.advanceTimersByTimeAsync(1_799_999); expect(cli.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cli.result).toEqual({ kind: "unknown", requestId: REQUEST, disposition: "unknown", reconcile: true });
    cli.frame(CAPABILITY); await vi.advanceTimersByTimeAsync(0); expect(cli.fetch).not.toHaveBeenCalled();
  } finally { await cli.close(); }
});

it("keeps a fresh ten-second HTTP deadline after a long owner wait", async () => {
  vi.useFakeTimers(); const cli = waitingClient(PAUSE, true);
  try {
    await vi.advanceTimersByTimeAsync(20_000); cli.frame(CAPABILITY); await vi.advanceTimersByTimeAsync(0);
    expect(cli.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999); expect(cli.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cli.result).toEqual({ kind: "unknown", requestId: REQUEST, disposition: "unknown", reconcile: true });
    expect(cli.fetch).toHaveBeenCalledOnce(); expect(cli.fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  } finally { await cli.close(); }
});

it("shares the 30-second read deadline between a slow handoff and HTTP", async () => {
  vi.useFakeTimers(); const cli = waitingClient(LIST, true);
  try {
    await vi.advanceTimersByTimeAsync(9_000); cli.frame(CAPABILITY); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_999); expect(cli.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cli.result).rejects.toHaveProperty("code", "unavailable"); expect(cli.fetch).toHaveBeenCalledOnce();
    expect(cli.fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  } finally { await cli.close(); }
});

it("returns an explicit owner denial after a long wait without sending HTTP", async () => {
  vi.useFakeTimers(); const cli = waitingClient();
  try {
    await vi.advanceTimersByTimeAsync(11_000); cli.frame({ v: 1, type: "routine.denied", code: "permission_denied" });
    await expect(cli.result).rejects.toHaveProperty("code", "permission_denied"); expect(cli.fetch).not.toHaveBeenCalled();
  } finally { await cli.close(); }
});

it.each(["abort", "disconnect", "host cancel"])("fences a late capability after owner-wait %s", async boundary => {
  vi.useFakeTimers(); const cli = waitingClient();
  try {
    await vi.advanceTimersByTimeAsync(11_000); expect(cli.settled()).toBe(false);
    if (boundary === "abort") cli.controller.abort();
    else if (boundary === "disconnect") cli.disconnect();
    else cli.frame({ v: 1, type: "routine.cancel" });
    expect(await cli.result).toEqual({ kind: "unknown", requestId: REQUEST, disposition: "unknown", reconcile: true });
    cli.frame(CAPABILITY); await vi.advanceTimersByTimeAsync(0); expect(cli.fetch).not.toHaveBeenCalled();
  } finally { await cli.close(); }
});
