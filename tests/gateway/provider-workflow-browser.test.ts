import { expect, it, vi } from "vitest";
import { createClaudeSettingsLogin, extractClaudeAuthorizationUrl } from "../../packages/gateway/src/ai-providers/provider-workflow-browser.js";
it("accepts only exact official browser authorization origins and paths", () => {
  expect(extractClaudeAuthorizationUrl("Visit https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=test")).toBe("https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=test");
  for (const url of ["https://evil.example/cai/oauth/authorize", "https://claude.com.evil.test/cai/oauth/authorize", "https://claude.com/profile?secret=x", "https://user:password@claude.com/cai/oauth/authorize", "https://claude.com:123/cai/oauth/authorize", "https://claude.com/cai/oauth/authorize#token"]) expect(extractClaudeAuthorizationUrl(url)).toBeNull();
});
it("holds a scoped browser login in Settings, submits code once, and enables only after native success", async () => {
  const publish = vi.fn(); const complete = vi.fn(); const release = vi.fn();
  const start = createClaudeSettingsLogin({ command: process.execPath, args: ["-e", 'console.log("https://claude.com/cai/oauth/authorize?state=fixture");process.stdin.once("data",()=>process.exit(0));'], cwd: process.cwd(), env: {}, acquire: async () => release });
  const running = await start({ publish, onSuccess: complete });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fixture" }));
  expect(complete).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  await running.submitCode!("fixture-authorization-code");
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null }));
  expect(complete).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  await expect(running.submitCode!("duplicate")).rejects.toThrow();
});
it("cancels and reaps before releasing the native lease and never enables", async () => {
  const complete = vi.fn(); const release = vi.fn();
  const start = createClaudeSettingsLogin({ command: process.execPath, args: ["-e", 'setInterval(()=>{},1000)'], cwd: process.cwd(), env: {}, acquire: async () => release });
  const running = await start({ publish: vi.fn(), onSuccess: complete });
  await running.cancel(); expect(release).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
  await expect(running.submitCode!("late-code")).rejects.toThrow();
});

it.each([
  ['nonzero exit / entitlement rejection', 'console.log("https://claude.com/cai/oauth/authorize?state=fixture");process.exit(1);', false],
  ['missing official authorization URL', 'console.log("https://example.test/login");process.exit(0);', false],
  ['failed credential reconciliation', 'console.log("https://claude.com/cai/oauth/authorize?state=fixture");process.exit(0);', true],
] as const)('fails safely on %s without claiming a subscription', async (_reason, script, reconciliationFails) => {
  const publish = vi.fn(); const release = vi.fn();
  const complete = vi.fn(async () => { if (reconciliationFails) throw new Error('synthetic private credential detail'); });
  const start = createClaudeSettingsLogin({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {}, acquire: async () => release });
  const running = await start({ publish, onSuccess: complete });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'unavailable' }));
  expect(complete).toHaveBeenCalledTimes(reconciliationFails ? 1 : 0);
  expect(release).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null });
  expect(JSON.stringify(publish.mock.calls)).not.toContain('private credential');
  await expect(running.submitCode('late-code')).rejects.toThrow();
});

it('expires and reaps an unanswered Claude flow before reporting expiry', async () => {
  const publish = vi.fn(); const complete = vi.fn(); const release = vi.fn();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const start = createClaudeSettingsLogin({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), env: {}, acquire: async () => release });
    const running = await start({ publish, onSuccess: complete });
    await vi.advanceTimersByTimeAsync(600000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: 'expired', safeFailure: 'expired' }));
    expect(release).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
    await expect(running.submitCode('late-code')).rejects.toThrow();
  } finally { vi.useRealTimers(); }
});

it('rejects multiline code injection and never publishes a submitted code or raw CLI output', async () => {
  const publish = vi.fn(); const release = vi.fn();
  const start = createClaudeSettingsLogin({ command: process.execPath, args: ['-e', 'console.log("https://claude.com/cai/oauth/authorize?state=fixture");process.stdin.once("data",data=>{console.log(data.toString());console.error("private-fixture-secret");process.exit(0);});'], cwd: process.cwd(), env: {}, acquire: async () => release });
  const running = await start({ publish, onSuccess: vi.fn() });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ authorizationUrl: 'https://claude.com/cai/oauth/authorize?state=fixture' }));
  await expect(running.submitCode('first\nsecond')).rejects.toThrow('conflict');
  await running.submitCode('synthetic-secret-code#synthetic-state');
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(JSON.stringify(publish.mock.calls)).not.toContain('synthetic-secret-code');
  expect(JSON.stringify(publish.mock.calls)).not.toContain('private-fixture-secret');
  await expect(running.submitCode('duplicate')).rejects.toThrow('conflict');
});

it('registers cleanup and retries a definitely unsent code through the engine', async () => {
  const { createProviderWorkflowService } = await import('../../packages/gateway/src/ai-providers/provider-workflows.js');
  const release = vi.fn(); const success = vi.fn(); const observed = vi.fn();
  const login = createClaudeSettingsLogin({ command: process.execPath, args: ['-e', 'setTimeout(()=>console.log("https://claude.com/cai/oauth/authorize?state=fixture"),100);process.stdin.once("data",()=>process.exit(0));'], cwd: process.cwd(), env: {}, acquire: async () => release });
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [{ harnessInstanceId: 'claude', harness: 'claude', displayName: 'Claude', installState: 'installed', loginMethods: ['browser'], apiKeyProviders: [], install: false, uninstall: false,
    start: input => login({ ...input, registerCleanup: cleanup => { observed(); input.registerCleanup(cleanup); }, onSuccess: success }) }] });
  const operation = await service.start('owner', { harnessInstanceId: 'claude', kind: 'login', method: 'browser', idempotencyKey: 'retry-before-prompt' });
  expect(observed).toHaveBeenCalledOnce();
  await expect(service.submitCode('owner', operation.id, 'early-code')).rejects.toThrow('conflict');
  await vi.waitFor(async () => expect((await service.status('owner', operation.id)).authorizationUrl).not.toBeNull());
  await service.submitCode('owner', operation.id, 'accepted-code');
  await vi.waitFor(async () => expect((await service.status('owner', operation.id)).state).toBe('succeeded'));
  expect(success).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  await service.close();
});
