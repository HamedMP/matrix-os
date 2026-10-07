import { afterEach, expect, it, vi } from "vitest";
import { createDesktopAoedeFetcher } from "../../desktop/src/renderer/src/lib/aoede-desktop";

it("pins bootstrap, history, events and ticket grants to the captured runtime", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ transport: { kind: "relayed_websocket", url: "/ws/chats/chat_a/voice/vs_a", ticket: "vt_fixture", epoch: 1 } }), { headers: { "content-type": "application/json" } }));
  const captured = createDesktopAoedeFetcher({ baseUrl: "https://platform.test", runtimeSlot: "pr-100", fetcher });
  const response = await captured("https://platform.test/api/chats/chat_a/voice/sessions", { method: "POST" });
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://platform.test/api/chats/chat_a/voice/sessions?runtime=pr-100");
  expect((await response.json()).transport.url).toBe("wss://platform.test/vm/pr-100/ws/chats/chat_a/voice/vs_a");
  await expect(captured("https://other.test/api/aoede/bootstrap")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});


afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function useTimeoutTimers() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

it("keeps canonical events open after headers but preserves owner cancellation", async () => {
  useTimeoutTimers();
  let signal!: AbortSignal;
  const fetcher = vi.fn(async (_input, init) => { signal = init!.signal!; return new Response(null, { headers: { "content-type": "text/event-stream" } }); }) as typeof fetch;
  const owner = new AbortController();
  const captured = createDesktopAoedeFetcher({ baseUrl: "https://platform.test", runtimeSlot: "primary", fetcher });
  await captured("https://platform.test/api/chats/events", { signal: owner.signal });
  await vi.advanceTimersByTimeAsync(31_000);
  expect(signal.aborted).toBe(false);
  owner.abort();
  expect(signal.aborted).toBe(true);
});

it("bounds event header waits and nonstream requests", async () => {
  useTimeoutTimers();
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!; signals.push(signal);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;
  const captured = createDesktopAoedeFetcher({ baseUrl: "https://platform.test", runtimeSlot: "primary", fetcher });
  const events = expect(captured("https://platform.test/api/chats/events")).rejects.toThrow();
  const bootstrap = expect(captured("https://platform.test/api/aoede/bootstrap")).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.all([events, bootstrap]);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});
