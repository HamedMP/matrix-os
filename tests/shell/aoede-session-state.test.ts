// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ handler: null as null | ((frame: unknown) => void), start: vi.fn(), close: vi.fn(), mute: vi.fn(), send: vi.fn(), event: null as null | ((event: unknown) => void) }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true, connectionEpoch: 1, send: h.send,
  subscribe: (handler: typeof h.handler) => { h.handler = handler; return () => {}; } }) }));
vi.mock("../../shell/src/aoede/media", () => ({ AoedeMedia: class {
  sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  constructor(options: { onEvent: typeof h.event }) { h.event = options.onEvent; }
  start = h.start; close = h.close; setMuted = h.mute; started = vi.fn();
} }));
import { useAoedeSession } from "../../shell/src/aoede/useAoedeSession";
const ready = { status: "setup_required", message: "Choose an execution provider in Settings." };
const onUi = () => ({ status: "failed" as const });
beforeEach(() => { vi.clearAllMocks(); h.start.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("readiness") ? ready : { session: null })))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("checks execution access before capture without auto-start and still allows deliberate voice", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  expect(hook.result.current.readiness).toEqual(ready);
  expect(h.start).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("readiness"))?.[1]).toMatchObject({ credentials: "same-origin" });
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  expect(h.start).toHaveBeenCalledOnce();
});
it("keeps a connecting microphone muted when provider startup completes", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); hook.result.current.toggleMute(); });
  act(() => h.event?.({ type: "session.started" }));
  expect(hook.result.current.muted).toBe(true);
});
it("exposes recovery failure separately and fences late recovery and startup callbacks", async () => {
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (String(url).endsWith("/session")) throw new Error("Unavailable");
    return new Response(JSON.stringify(ready));
  });
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  expect(hook.result.current.recoveryError).toBe(true);
  expect(hook.result.current.status).toBe("idle");
  let reject!: (error: Error) => void;
  h.start.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  const oldEvent = h.event;
  act(() => { hook.result.current.stop("closed"); hook.result.current.start(); });
  await act(async () => { reject(new DOMException("Denied", "NotAllowedError")); oldEvent?.({ type: "error" }); });
  expect(hook.result.current.status).toBe("connecting");
});
it("shows malformed and failed catalog responses without treating them as subscription requirements", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready" })));
  await act(async () => { await hook.result.current.refreshReadiness(); });
  expect(hook.result.current.readiness.status).toBe("error");
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Catalog offline"));
  await act(async () => { await hook.result.current.refreshReadiness(); });
  expect(hook.result.current.readiness.status).toBe("error");
  vi.mocked(fetch).mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
  await act(async () => { await hook.result.current.refreshReadiness(); });
  expect(hook.result.current.readiness.status).toBe("error");
});
it.each(["ready", "setup_required", "unavailable", "error"])("preserves canonical %s readiness", async (status) => {
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith("readiness") ? { status, message: "Canonical explanation" } : { session: null })));
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  expect(hook.result.current.readiness).toEqual({ status, message: "Canonical explanation" });
});
it.each([[new DOMException("Denied", "NotAllowedError"), "denied"], [new Error("Provider unavailable"), "error"]])("distinguishes startup failure %s", async (error, status) => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  h.start.mockRejectedValueOnce(error);
  await act(async () => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  expect(hook.result.current.status).toBe(status);
  expect(h.start).toHaveBeenCalledOnce();
});
it("aborts superseded and dismissed queries and fences their late results", async () => {
  const hook = renderHook(({ active }) => useAoedeSession(active, onUi), { initialProps: { active: true } });
  await act(async () => {});
  let resolve!: (response: Response) => void;
  let signal!: AbortSignal;
  vi.mocked(fetch).mockImplementationOnce((_url, init) => { signal = init!.signal!; return new Promise((r) => { resolve = r; }); });
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.refreshReadiness(); });
  await act(async () => { await hook.result.current.refreshReadiness(); });
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(new Response(JSON.stringify({ status: "ready", message: "Old" }))); await pending; });
  expect(hook.result.current.readiness).toEqual(ready);
  vi.mocked(fetch).mockImplementationOnce((_url, init) => { signal = init!.signal!; return new Promise((r) => { resolve = r; }); });
  act(() => { pending = hook.result.current.refreshReadiness(); });
  hook.rerender({ active: false });
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(new Response(JSON.stringify({ status: "ready", message: "Old" }))); await pending; });
  expect(hook.result.current.readiness.status).not.toBe("ready");
  expect(h.start).not.toHaveBeenCalled();
});
it("refreshes on settings and focus without reminting or erasing captions", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start();
    h.event?.({ type: "session.output_transcript.delta", delta: "Keep", start_ms: 1, end_ms: 2 }); });
  await act(async () => { window.dispatchEvent(new Event("matrix:provider-settings-changed")); window.dispatchEvent(new Event("focus")); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("readiness"))).toHaveLength(3);
  expect(hook.result.current.captions[0].text).toBe("Keep");
  expect(h.start).toHaveBeenCalledOnce();
});
it("retains only twelve exact-session task failures and never replays uncertain work", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  const frame = { type: "aoede:task_error", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", delegationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", outcome: "uncertain", message: "Check Chat before retrying." };
  act(() => { h.handler?.({ ...frame, sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }); });
  expect(hook.result.current.taskErrors).toEqual([]);
  act(() => { for (let i = 0; i < 14; i++) h.handler?.(frame); });
  expect(hook.result.current.taskErrors).toHaveLength(12);
  expect(hook.result.current.taskErrors[0].outcome).toBe("uncertain");
  act(() => h.handler?.({ ...frame, outcome: "not_started" }));
  expect(hook.result.current.taskErrors.at(-1)?.outcome).toBe("not_started");
  expect(h.send).not.toHaveBeenCalled();
  act(() => { hook.result.current.toggleMute(); hook.result.current.toggleMute(); });
  expect(h.mute.mock.calls).toEqual([[true], [false]]);
  act(() => { hook.result.current.toggleMute(); hook.result.current.stop("closed"); h.handler?.(frame); });
  expect(hook.result.current.muted).toBe(false);
  expect(hook.result.current.taskErrors).toHaveLength(12);
  act(() => hook.result.current.start());
  expect(hook.result.current.taskErrors).toEqual([]);
});
