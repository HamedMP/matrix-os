// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null, handler: null as null | ((frame: unknown) => void), start: vi.fn(), close: vi.fn(), mute: vi.fn(), playback: vi.fn(), send: vi.fn(), event: null as null | ((event: unknown) => void), options: null as null | { onFailure: (failure: { phase: "mint"; code: "conflict" }) => void; onPhase: (phase: "mint") => void; onReconnecting: (value: boolean) => void; onPlaybackBlocked: (value: boolean) => void } }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true, connectionEpoch: 1, send: h.send,
  subscribe: (handler: typeof h.handler) => { h.handler = handler; return () => {}; } }) }));
vi.mock("../../packages/ui/src/aoede/media", () => ({ AoedeMedia: class {
  get sessionId() { return h.sessionId; }
  constructor(options: { onEvent: typeof h.event } & NonNullable<typeof h.options>) { h.event = options.onEvent; h.options = options; }
  start = h.start; close = h.close; setMuted = h.mute; started = vi.fn(); resumePlayback = h.playback;
} }));
import { useAoedeSession } from "../../shell/src/aoede/useAoedeSession";
const ready = { status: "setup_required", message: "Choose an execution provider in Settings." };
const onUi = () => ({ status: "failed" as const });
beforeEach(() => { vi.clearAllMocks(); h.sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; h.start.mockResolvedValue(undefined);
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
  await act(async () => h.event?.({ type: "session.started" }));
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
it("refreshes on settings but not focus without reminting or erasing captions", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start();
    h.event?.({ type: "session.output_transcript.delta", delta: "Keep", start_ms: 1, end_ms: 2 }); });
  await act(async () => { window.dispatchEvent(new Event("matrix:provider-settings-changed")); window.dispatchEvent(new Event("focus")); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("readiness"))).toHaveLength(2);
  expect(hook.result.current.captions[0].text).toBe("Keep");
  expect(h.start).toHaveBeenCalledOnce();
});
it("retains early session.started until answer settles and sends ready exactly once", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi)); await act(async () => {});
  h.sessionId = null;
  let resolve!: () => void;
  h.start.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); h.event?.({ type: "session.started" }); });
  expect(hook.result.current.status).toBe("connecting"); expect(h.send).not.toHaveBeenCalled();
  await act(async () => { h.sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; resolve(); });
  expect(hook.result.current.status).toBe("active");
  act(() => h.event?.({ type: "session.started" }));
  expect(h.send).toHaveBeenCalledExactlyOnceWith({ type: "aoede:ready", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  act(() => hook.result.current.stop("closed"));
  expect(hook.result.current.resumeSessionId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});
it.each([null, new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 60000).toISOString()])("exposes canonical conversation resume independently of speech checkpoint expiry %s", async (until) => {
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith("readiness") ? ready : { session: { state: "interrupted" }, resumeSessionId: id, recoveryAvailableUntil: until })));
  const hook = renderHook(() => useAoedeSession(true, onUi)); await act(async () => {});
  expect(hook.result.current.resumeSessionId).toBe(id); expect(h.start).not.toHaveBeenCalled();
  await act(async () => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(id); });
  expect(h.start).toHaveBeenCalledWith(id);
});
it("keeps playback and reconnect flags through early activation, exposes failures and fences old callbacks", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi)); await act(async () => {});
  let resolve!: () => void; h.start.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  const old = h.options!;
  act(() => { old.onPhase("mint"); old.onPlaybackBlocked(true); old.onReconnecting(true); h.event?.({ type: "session.started" }); });
  expect(hook.result.current.phase).toBe("mint");
  await act(async () => { resolve(); });
  expect(hook.result.current.phase).toBeNull(); expect(hook.result.current.playbackBlocked).toBe(true); expect(hook.result.current.reconnecting).toBe(true);
  await act(async () => { await hook.result.current.resumePlayback(); }); expect(h.playback).toHaveBeenCalledOnce();
  act(() => old.onFailure({ phase: "mint", code: "conflict" }));
  expect(hook.result.current.failure).toEqual({ phase: "mint", code: "conflict" });
  act(() => { hook.result.current.start(); old.onPlaybackBlocked(true); old.onFailure({ phase: "mint", code: "conflict" }); });
  expect(hook.result.current.failure).toBeNull(); expect(hook.result.current.playbackBlocked).toBe(false);
});
it("shares only concurrent readiness checks across hooks and invalidates them on settings", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith("readiness") ? new Promise<Response>((r) => { resolve = r; }) : new Response(JSON.stringify({ session: null })));
  const a = renderHook(() => useAoedeSession(true, onUi));
  const b = renderHook(() => useAoedeSession(true, onUi));
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("readiness"))).toHaveLength(1);
  const oldResolve = resolve;
  act(() => window.dispatchEvent(new Event("matrix:provider-settings-changed")));
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("readiness"))).toHaveLength(2);
  await act(async () => { oldResolve(new Response(JSON.stringify({ status: "ready", message: "Stale" }))); });
  expect(a.result.current.readiness.status).toBe("checking"); expect(b.result.current.readiness.status).toBe("checking");
  await act(async () => { resolve(new Response(JSON.stringify(ready))); });
  expect(a.result.current.readiness).toEqual(ready); expect(b.result.current.readiness).toEqual(ready);
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith("readiness") ? ready : { session: null })));
  await act(async () => { await a.result.current.refreshReadiness(); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("readiness"))).toHaveLength(3);
});
it("warns before unload only while connecting or active", async () => {
  const hook = renderHook(() => useAoedeSession(true, onUi)); await act(async () => {});
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  act(() => hook.result.current.stop("closed"));
  const ended = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(ended); expect(ended.defaultPrevented).toBe(false);
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

it.each(["approval", "running", "queued"] as const)("retains %s through the full recovery stream and repeated refresh", async status => {
  const hook = renderHook(() => useAoedeSession(true, onUi));
  await act(async () => {});
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  const current = { id: "current", chatId: "chat_current", title: "Current task", status };
  const send = (card: typeof current | { id: string; chatId: string; title: string; status: "done" }) =>
    h.handler?.({ type: "aoede:card", sessionId: h.sessionId, card });
  for (const count of [11, 12, 15, 15]) {
    act(() => { send(current); for (let i = 0; i < count; i++) send({ id: `done-${i}`, chatId: "chat_current", title: "Old task", status: "done" }); });
    expect(hook.result.current.cards).toHaveLength(12);
    expect(hook.result.current.cards).toContainEqual(current);
    expect(hook.result.current.cards.filter(c => c.status === "done")).toHaveLength(11);
  }
  act(() => send({ ...current, status: "done" }));
  expect(hook.result.current.cards.find(c => c.id === "current")?.status).toBe("done");
  expect(hook.result.current.cards).toHaveLength(12);
});
