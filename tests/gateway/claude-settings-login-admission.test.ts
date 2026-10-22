import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeSettingsLogin } from "../../packages/gateway/src/ai-providers/provider-workflow-browser.js";
import { createProviderWorkflowService, ProviderWorkflowNotStartedError } from "../../packages/gateway/src/ai-providers/provider-workflows.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
it.each(["running", "unknown"] as const)("retries a Claude login rejected by %s managed liveness after the existing session stops", async initialLiveness => {
  const root = await mkdtemp(join(tmpdir(), "claude-admission-")); homes.push(root);
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  let liveness: "running" | "stopped" | "unknown" = initialLiveness;
  const registry = { listProfileSessions: async () => [{ name: "provider-login-claude-existing", agent: "claude" }],
    get: vi.fn(), observeAgentLiveness: async () => liveness };
  const guard = createNativeProviderProfileGuard({ homePath: home, registry });
  const nativeLogin = createClaudeSettingsLogin({ command: process.execPath, args: ["-e", 'console.log("https://claude.com/cai/oauth/authorize?state=fixture");setInterval(()=>{},1000);'],
    cwd: home, env: { HOME: home }, acquire: () => guard.acquire("claude", { kind: "write", durable: true }) });
  const service = createProviderWorkflowService({ ownerId: "owner", adapters: [{ harnessInstanceId: "claude", harness: "claude", displayName: "Claude", installState: "installed",
    loginMethods: ["browser"], apiKeyProviders: [], install: false, uninstall: false,
    start: input => nativeLogin({ ...input, onSuccess: vi.fn() }) }] });
  try {
    const first = service.start("owner", { harnessInstanceId: "claude", kind: "login", method: "browser", idempotencyKey: "first" });
    if (initialLiveness === "running") await expect(first).rejects.toMatchObject({ code: "conflict" });
    else expect(await first).toMatchObject({ state: "failed", safeFailure: "unavailable" });
    liveness = "stopped";
    const retry = await service.start("owner", { harnessInstanceId: "claude", kind: "login", method: "browser", idempotencyKey: "retry" });
    expect(retry.state).toBe("running");
    await vi.waitFor(async () => expect((await service.status("owner", retry.id)).authorizationUrl).not.toBeNull());
  } finally { await service.close(); }
});

it("logs only the bounded admission code, never native credentials or private details", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = new ProviderWorkflowNotStartedError("conflict");
  error.message = "private-token /owner/credentials";
  const service = createProviderWorkflowService({ ownerId: "owner", adapters: [{ harnessInstanceId: "claude", harness: "claude", displayName: "Claude", installState: "installed", loginMethods: ["browser"], apiKeyProviders: [], install: false, uninstall: false, start: async () => { throw error; } }] });
  try {
    await expect(service.start("owner", { harnessInstanceId: "claude", kind: "login", method: "browser", idempotencyKey: "private-error" })).rejects.toMatchObject({ code: "conflict" });
    expect(warning).toHaveBeenCalledWith("[provider-workflow] Start failed:", "Error", "conflict");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("/owner/credentials");
  } finally { await service.close(); warning.mockRestore(); }
});


it("retries after a concurrent in-process profile admission drains without retaining cleanup for an unstarted login", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-concurrent-admission-")); homes.push(root);
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), listProfileSessions: async () => [], observeAgentLiveness: async () => "stopped" } });
  const release = await guard.acquire("claude", { kind: "write", durable: true });
  const nativeLogin = createClaudeSettingsLogin({ command: process.execPath, args: ["-e", 'console.log("https://claude.com/cai/oauth/authorize?state=fixture");setInterval(()=>{},1000);'], cwd: home, env: { HOME: home }, acquire: () => guard.acquire("claude", { kind: "write", durable: true }) });
  const service = createProviderWorkflowService({ ownerId: "owner", adapters: [{ harnessInstanceId: "claude", harness: "claude", displayName: "Claude", installState: "installed", loginMethods: ["browser"], apiKeyProviders: [], install: false, uninstall: false, start: input => nativeLogin({ ...input, onSuccess: vi.fn() }) }] });
  try {
    await expect(service.start("owner", { harnessInstanceId: "claude", kind: "login", method: "browser", idempotencyKey: "blocked" })).rejects.toMatchObject({ code: "conflict" });
    await release();
    const retry = await service.start("owner", { harnessInstanceId: "claude", kind: "login", method: "browser", idempotencyKey: "retry" });
    expect(retry.state).toBe("running");
    await vi.waitFor(async () => expect((await service.status("owner", retry.id)).authorizationUrl).not.toBeNull());
  } finally { await release(); await service.close(); }
});
