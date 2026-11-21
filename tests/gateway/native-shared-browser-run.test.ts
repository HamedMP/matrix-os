import { afterEach, expect, it, vi } from "vitest";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";
import { openNativeSharedBrowserRun } from "../../packages/gateway/src/chat/native-shared-browser-run.js";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { configureClaudeSharedBrowser } from "../../packages/gateway/src/chat/claude-shared-browser-launch.js";
import { nativePhaseMcpServers } from "../../packages/gateway/src/chat/claude-native-session-control.js";
const brokers: ReturnType<typeof createSharedBrowserBroker>[] = [];
afterEach(async () => { await Promise.all(brokers.splice(0).map(broker => broker.close())); });
function fixture() {
  const broker = createSharedBrowserBroker({ ownerId: "owner", driver: { execute: async () => ({ success: true, observationId: "obs", content: "Page" }), detach: async () => {}, invalidateObservation() {} }, setHumanControl: async () => {} });
  brokers.push(broker);
  const input = { owner: { type: "personal", ownerId: "owner" }, chatId: "chat", runId: "run", permissionMode: "full_access", interactionMode: "default", signal: new AbortController().signal };
  return { broker, input, options: { broker, gatewayPort: 4000, harness: "claude_code" as const } };
}
it("admits only supported exact-owner personal default runs and fixed gateway ports", () => {
  const f = fixture();
  for (const patch of [{ owner: { type: "org", ownerId: "owner" } }, { sharedScopeId: "shared" }, { permissionMode: "auto_accept_edits" }, { interactionMode: "review" }]) expect(openNativeSharedBrowserRun(f.options, { ...f.input, ...patch })).toBeUndefined();
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
it("refreshes only the current browser and integrations grants over the native control channel", async () => {
  const f = fixture(); const first = openNativeSharedBrowserRun(f.options, f.input)!;
  const oldBinding = f.broker.resolveCapability(first.token)!;
  const launch = buildAgentLaunch({ agent: "claude", cwd: "/safe", matrixCustomMcp: true,
    sandbox: { enabled: false, mode: "danger-full-access" }, claudePermissionMode: "bypassPermissions" });
  configureClaudeSharedBrowser(launch, first);
  const firstConfig = nativePhaseMcpServers(launch.args, { ...first.mcpServer.env, MATRIX_AGENT_INTEGRATIONS_TOKEN: "integration-first", UNRELATED_SECRET: "private" });
  await first.close();
  const next = openNativeSharedBrowserRun({ ...f.options, gatewayPort: 4001 }, { ...f.input, runId: "next" })!;
  const nextConfig = nativePhaseMcpServers(launch.args, { ...next.mcpServer.env, MATRIX_AGENT_INTEGRATIONS_TOKEN: "integration-next", UNRELATED_SECRET: "private" });
  expect((firstConfig.matrix_shared_browser as { env: unknown }).env).toEqual(first.mcpServer.env);
  expect((nextConfig.matrix_shared_browser as { env: unknown }).env).toEqual(next.mcpServer.env);
  expect((nextConfig["matrix-integrations"] as { env: unknown }).env).toEqual({ MATRIX_AGENT_INTEGRATIONS_TOKEN: "integration-next" });
  expect(launch.args.join(" ")).not.toContain(first.token);
  expect(launch.args.join(" ")).not.toContain(next.token);
  expect(f.broker.resolveCapability(first.token)).toBeNull();
  expect(f.broker.resolveCapability(next.token)?.runId).toBe("next");
  await expect(f.broker.execute(oldBinding, { action: "snapshot" }, f.input.signal)).rejects.toHaveProperty("code", "run_unavailable");
  await next.close();
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
it("never replaces a live execution when duplicate canonical admission races", async () => {
  const f=fixture();const original=openNativeSharedBrowserRun(f.options,f.input)!;
  expect(()=>openNativeSharedBrowserRun(f.options,f.input)).toThrow("Browser run unavailable");
  expect(f.broker.resolveCapability(original.token)).not.toBeNull();await original.close();
});
it("awaits the exact abort-started browser drain before closing the execution lease",async()=>{
  let entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});const work=new Promise<void>(resolve=>{finish=resolve;});
  const broker=createSharedBrowserBroker({ownerId:"owner",driver:{execute:async()=>{entered();await work;return{success:true,observationId:"obs",content:"Page"};},detach:async()=>{},invalidateObservation(){}},setHumanControl:async()=>{}});brokers.push(broker);
  const controller=new AbortController();const run=openNativeSharedBrowserRun({broker,gatewayPort:4000,harness:"codex"},{owner:{type:"personal",ownerId:"owner"},chatId:"chat",runId:"run",permissionMode:"full_access",interactionMode:"default",signal:controller.signal})!;
  const action=broker.execute(broker.resolveCapability(run.token)!,{action:"snapshot"},controller.signal);
  const rejected=expect(action).rejects.toMatchObject({name:"SharedBrowserError",code:"browser_changed"});
  await started;controller.abort();expect(run.isLive()).toBe(false);
  let closed=false;const close=run.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
  finish();await rejected;await close;expect(closed).toBe(true);
});
