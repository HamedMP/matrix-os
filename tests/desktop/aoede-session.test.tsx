// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ close: vi.fn(), start: vi.fn(async () => undefined), mute: vi.fn(),
  event: null as null | ((event: unknown) => void),
}));
vi.mock("../../packages/ui/src/aoede/media", () => ({ AoedeMedia: class {
  sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  constructor(options: { onEvent: typeof h.event }) { h.event = options.onEvent; }
  start = h.start; close = h.close; setMuted = h.mute; started() {}
} }));
import { useAoedeSession } from "../../packages/ui/src/aoede/useAoedeSession";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("stops capture on disconnect and requires a deliberate start after reconnection", async () => {
  const fetchFn = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith("readiness")
    ? { status: "ready", message: "Tasks are ready" } : { session: null })));
  const submitApproval = vi.fn(async () => true);
  const send = vi.fn(() => true);
  const options = { gatewayUrl: "https://desktop.example", identityKey: "owner:preview:7", fetchFn, submitApproval,
    socket: { connected: true, connectionEpoch: 4, send,
      subscribe: () => () => {} } };
  const hook = renderHook(({ connected }) => useAoedeSession(true, () => ({ status: "failed" }),
    { ...options, socket: { ...options.socket, connected } }), { initialProps: { connected: true } });
  await act(async () => {});
  expect(hook.result.current.readiness.status).toBe("ready");
  expect(h.start).not.toHaveBeenCalled();
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  await act(async () => { h.event?.({ type: "session.started" }); });
  expect(hook.result.current.status).toBe("active");
  hook.rerender({ connected: false });
  expect(hook.result.current.status).toBe("interrupted");
  expect(h.close).toHaveBeenCalledOnce();
  hook.rerender({ connected: true });
  expect(h.start).toHaveBeenCalledOnce();
});
