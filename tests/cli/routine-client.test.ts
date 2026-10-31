import { afterEach, expect, it, vi } from "vitest";
import { executeRoutineOperation } from "../../packages/sync-client/src/cli/routine-client.js";
import { getEventListeners } from "node:events";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
  const controller = new AbortController();
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
    expect(fetch).toHaveBeenCalledOnce(); expect(process.send).toHaveBeenCalledOnce();
    expect(process.listenerCount("message")).toBe(messages); expect(process.listenerCount("disconnect")).toBe(disconnects);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    Object.defineProperty(AbortSignal, "any", any);
    if (send) Object.defineProperty(process, "send", send); else delete process.send;
    if (connected) Object.defineProperty(process, "connected", connected); else delete (process as Partial<NodeJS.Process>).connected;
  }
});
