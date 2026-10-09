import { afterEach, expect, it, vi } from "vitest";
import { callIntegrationReadHandler, createScopedIntegrationReadFetcher } from "../../packages/kernel/src/tools/integration-read.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const input = { service: "google_drive", action: "list_files", label: "Work", params: {} };
const url = "http://localhost:4000/api/integrations/read-call";

it.each([undefined, "", "bad-token"])("fails before any host-bearer fallback with capability %s", async token => {
  vi.stubEnv("MATRIX_AUTH_TOKEN", "must-not-forward");
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", token);
  const fetcher = vi.fn<GatewayFetcher>();
  const request = createScopedIntegrationReadFetcher(fetcher);
  const result = await callIntegrationReadHandler(input, request);
  expect(result.isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it("refuses arbitrary hosts, paths, query strings and methods", async () => {
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
  const fetcher = vi.fn<GatewayFetcher>();
  const request = createScopedIntegrationReadFetcher(fetcher);
  for (const [target, method] of [["https://evil.test/api/integrations/read-call", "POST"], ["http://localhost:4000/api/integrations/call", "POST"], [`${url}?extra=true`, "POST"], [url, "GET"], ["http://localhost:4000/api/integrations", "DELETE"]]) {
    await expect(request(target!, { method })).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  () => new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }),
  () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } })),
  () => new Response("private invalid JSON"),
  () => new Response(null, { status: 204 }),
])("returns a safe failure for malformed/oversized responses", async response => {
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
  const result = await callIntegrationReadHandler(input, createScopedIntegrationReadFetcher(async () => response()));
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("Integration read is unavailable");
  expect(JSON.stringify(result)).not.toContain("private");
});

it("cancels a stalled response on deadline and releases the stream", async () => {
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
  const controller = new AbortController();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const request = createScopedIntegrationReadFetcher(async () => response);
  const pending = request(url, { method: "POST", signal: controller.signal });
  const assertion = expect(pending).rejects.toThrow();
  await Promise.resolve();
  controller.abort();
  await assertion;
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
});

it("rejects oversized or extra call input before sending any broker request", async () => {
  const fetcher = vi.fn<GatewayFetcher>();
  for (const value of [{ ...input, app: "forged" }, { ...input, params: { content: "x".repeat(65_536) } }, { ...input, label: " " }]) {
    expect((await callIntegrationReadHandler(value, fetcher)).isError).toBe(true);
  }
  expect(fetcher).not.toHaveBeenCalled();
});
