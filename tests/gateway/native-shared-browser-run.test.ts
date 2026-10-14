import { afterEach, expect, it, vi } from "vitest";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";
import { openNativeSharedBrowserRun } from "../../packages/gateway/src/chat/native-shared-browser-run.js";
const brokers: ReturnType<typeof createSharedBrowserBroker>[] = [];
afterEach(async () => { await Promise.all(brokers.splice(0).map(broker => broker.close())); });
function fixture() {
  const broker = createSharedBrowserBroker({ ownerId: "owner", driver: { execute: async () => ({ success: true, observationId: "obs", content: "Page" }), detach: async () => {}, invalidateObservation() {} }, setHumanControl: async () => {} });
  brokers.push(broker);
  const input = { owner: { type: "personal", ownerId: "owner" }, chatId: "chat", runId: "run", permissionMode: "full_access", interactionMode: "default", signal: new AbortController().signal };
  return { broker, input, options: { broker, gatewayPort: 4000, harness: "claude_code" as const } };
}
it("admits only exact owner personal full-access default runs and fixed gateway ports", () => {
  const f = fixture();
  for (const patch of [{ owner: { type: "org", ownerId: "owner" } }, { sharedScopeId: "shared" }, { permissionMode: "supervised" }, { interactionMode: "review" }]) expect(openNativeSharedBrowserRun(f.options, { ...f.input, ...patch })).toBeUndefined();
  expect(() => openNativeSharedBrowserRun(f.options, { ...f.input, owner: { type: "personal", ownerId: "foreign" } })).toThrow("Browser run unavailable");
  expect(() => openNativeSharedBrowserRun({ ...f.options, gatewayPort: 0 }, f.input)).toThrow();
});
it("uses a fresh attempt nonce and bearer, exposes only one fixed stdio tool server", async () => {
  const f = fixture(); const a = openNativeSharedBrowserRun(f.options, f.input)!;
  expect(a.mcpServer).toMatchObject({ command: "/opt/matrix/runtime/node/bin/node", args: ["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"] });
  expect(a.mcpServer.env.MATRIX_SHARED_BROWSER_GATEWAY_PORT).toBe("4000");
  expect(f.broker.resolveCapability(a.token)).toEqual({ ownerId: "owner", chatId: "chat", runId: "run", harness: "claude_code" });
  await a.close(); const b = openNativeSharedBrowserRun({ ...f.options, harness: "codex" }, f.input)!;
  expect(b.attemptId).not.toBe(a.attemptId); expect(b.token).not.toBe(a.token); expect(f.broker.resolveCapability(a.token)).toBeNull();
  await a.close(); expect(f.broker.resolveCapability(b.token)).not.toBeNull(); await b.close();
});
it("stale delayed cleanup never closes a reused run ID's new bearer", async () => {
  const f = fixture(); const a = openNativeSharedBrowserRun(f.options, f.input)!;
  await f.broker.closeRun("run"); const b = openNativeSharedBrowserRun(f.options, f.input)!;
  await a.close(); expect(f.broker.resolveCapability(b.token)).not.toBeNull(); await b.close();
});
it("revokes immediately on abort and close is idempotent with a bounded drain", async () => {
  const f = fixture(); const controller = new AbortController();
  const a = openNativeSharedBrowserRun(f.options, { ...f.input, signal: controller.signal })!;
  const close = vi.spyOn(f.broker, "closeRun"); controller.abort();
  expect(f.broker.resolveCapability(a.token)).toBeNull(); await a.close(); await a.close(); expect(close.mock.calls.length).toBeLessThanOrEqual(1);
  expect(() => openNativeSharedBrowserRun(f.options, { ...f.input, signal: controller.signal })).toThrow();
});
