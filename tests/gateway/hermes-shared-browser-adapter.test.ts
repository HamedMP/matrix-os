import { expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { fakeGateway, baseInput } from "./hermes-test-gateway.js";
async function collect(iterable: AsyncIterable<unknown>) { const rows = []; for await (const row of iterable) rows.push(row); return rows; }
it("injects the exact run MCP through native bootstrap and requires native catalog proof before inference", async () => {
  const gateway = fakeGateway();
  const broker = { openRun: vi.fn(() => ({ token: "a".repeat(43), expiresAt: Date.now()+60000 })), closeRun: vi.fn(async () => undefined) };
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn, sharedBrowser: broker as never, sharedBrowserGatewayPort: 4000 });
  const work = collect(adapter.start(baseInput));
  await vi.waitFor(() => expect(gateway.requests.some(request => request.method === "config.set" && request.params.key === "yolo")).toBe(true));
  expect(gateway.requests.some(request => request.method === "prompt.submit")).toBe(false);
  gateway.event("session.info", { provider: "openai-codex", model: "gpt-5.6-luna", lazy: false, tools: { mcp: ["mcp__matrix_shared_browser__shared_browser"], files: ["read_file"] } });
  await vi.waitFor(() => expect(gateway.requests.some(request => request.method === "prompt.submit")).toBe(true));
  gateway.event("message.complete", { text: "Collected fixture invoices", status: "complete" });
  expect((await work).at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  expect(broker.openRun).toHaveBeenCalledWith({ ownerId: baseInput.owner.ownerId, chatId: baseInput.chatId, runId: baseInput.runId, harness: "hermes" }, baseInput.signal);
  const spawn = gateway.spawnFn.mock.calls[0]!;
  expect(spawn[1]).toContain("-c");
  expect(spawn[2].env).toMatchObject({ MATRIX_SHARED_BROWSER_TOKEN: "a".repeat(43), MATRIX_SHARED_BROWSER_GATEWAY_PORT: "4000" });
  expect(broker.closeRun).toHaveBeenCalledWith(baseInput.runId);
});
it("revokes the browser on cancellation while keeping native startup/run cleanup attached", async () => {
  const gateway = fakeGateway(); const controller = new AbortController();
  const broker = { openRun: vi.fn(() => ({ token: "a".repeat(43), expiresAt: Date.now()+60000 })), closeRun: vi.fn(async () => undefined) };
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn, sharedBrowser: broker as never, sharedBrowserGatewayPort: 4000 });
  const work = collect(adapter.start({ ...baseInput, signal: controller.signal }));
  await vi.waitFor(() => expect(gateway.requests.some(request => request.method === "session.create")).toBe(true));
  controller.abort();
  expect((await work).at(-1)).toMatchObject({ type: "run.completed", outcome: "aborted" });
  expect(broker.closeRun).toHaveBeenCalledOnce();
});
