import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalShellChatClient } from "../../../shell/src/lib/canonical-chat-client.js";
import { createCanonicalChatClient } from "../../../desktop/src/renderer/src/lib/canonical-chat-client.js";
import { createApiClient } from "../../../desktop/src/renderer/src/lib/api.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function delayedClient(surface: "Web" | "Electron", delay: number) {
  vi.useFakeTimers();
  // Drive the actual transport's AbortSignal boundary with the test clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  const catalog = createCanonicalProviderCatalogFixture();
  const fetchFn = vi.fn((_input: unknown, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify(catalog), { status: 200 })), delay);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  }));
  const client = surface === "Web"
    ? createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn }).agents!
    : createCanonicalChatClient(createApiClient({ baseUrl: "https://matrix.test", getRuntimeSlot: () => "primary", fetchFn })).agents!;
  return { client, catalog, fetchFn };
}

it.each(["Web", "Electron"] as const)("accepts a 12.5s catalog response through the actual %s transport", async surface => {
  const { client, catalog } = delayedClient(surface, 12_500);
  const result = client.catalog().then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(12_500);
  expect(await result).toEqual({ value: catalog });
});

it.each(["Web", "Electron"] as const)("bounds forced catalog refresh at the shared readiness deadline in %s", async surface => {
  const { client } = delayedClient(surface, 40_000);
  let settled = false;
  const result = client.catalog({ refresh: true }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  await vi.advanceTimersByTimeAsync(FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toHaveProperty("error");
});

it.each(["Web", "Electron"] as const)("keeps unrelated Agent requests at the existing 10s deadline in %s", async surface => {
  const { client } = delayedClient(surface, 12_500);
  let settled = false;
  const result = client.recipeCatalog().catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(settled).toBe(true);
  expect(await result).toBeInstanceOf(Error);
});
