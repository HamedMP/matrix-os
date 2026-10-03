import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createNativeProviderProfileGuard } from '../../packages/gateway/src/ai-providers/native-provider-profile-guard.js';
let home = '';
afterEach(async () => { if (home) { await rm(home, { recursive: true, force: true }); await rm(join(dirname(home), '.matrix-private', basename(home)), { recursive: true, force: true }); } });
async function fixture() { home = await mkdtemp(join(tmpdir(), 'profile-guard-')); await mkdir(join(home, 'system/ai-providers'), { recursive: true }); }
describe('shared native profile admission', () => {
  it('blocks historical expired-but-live login after restart, permits exact recovery replay, releases only after stopped', async () => {
    await fixture(); let state: 'running' | 'stopped' | 'unknown' = 'running';
    await writeFile(join(home, 'system/ai-providers/login-receipts.json'), JSON.stringify({ version: 1, receipts: [{ recoveryHash: 'a'.repeat(64), attempt: { id: 'attempt_1', harnessInstanceId: 'harness_codex', accountId: null, method: 'terminal', state: 'pending', action: { kind: 'open_terminal', terminalSessionId: 'provider-auth-test' }, expiresAt: '2020-01-01T00:00:00Z', safeFailure: null } }] }));
    const registry = { get: async () => ({ name: 'provider-auth-test', agent: 'codex' }), observeAgentLiveness: async () => state };
    const guard = createNativeProviderProfileGuard({ homePath: home, registry });
    await expect(guard.run('codex', { kind: 'write' }, async () => 'key')).rejects.toThrow();
    expect(await guard.run('codex', { kind: 'login', recoveryKey: 'a'.repeat(64) }, async () => 'replay')).toBe('replay');
    const restarted = createNativeProviderProfileGuard({ homePath: home, registry });
    state = 'unknown'; await expect(restarted.run('codex', { kind: 'write' }, async () => 'logout')).rejects.toThrow();
    state = 'stopped'; expect(await restarted.run('codex', { kind: 'write' }, async () => 'key')).toBe('key');
  });
  it('serializes key and logout across API paths without blocking the independent Claude profile', async () => {
    await fixture(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const guard = createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), observeAgentLiveness: vi.fn() } });
    const first = guard.run('codex', { kind: 'write' }, async () => { await gate; return 'key'; });
    const second = vi.fn(); const logout = guard.run('codex', { kind: 'write' }, async () => { second(); return 'logout'; });
    const refused = expect(logout).rejects.toThrow();
    expect(await guard.run('claude', { kind: 'write' }, async () => 'independent')).toBe('independent'); expect(second).not.toHaveBeenCalled();
    release(); expect(await first).toBe('key'); await refused;
  });
});

import { createProviderTerminalLoginCoordinator } from '../../packages/gateway/src/ai-providers/provider-terminal-login-coordinator.js';
import { createProviderCliAccountLifecycleCoordinator } from '../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js';
import { createProviderKeyVerifier } from '../../packages/gateway/src/ai-providers/provider-workflow-key.js';
import type { ProviderLifecycleAccount } from '../../packages/gateway/src/ai-providers/provider-settings-coordinators.js';
it('coordinates actual canonical login, logout and key endpoints, including restart and exact replay', async () => {
  await fixture(); let state: 'running' | 'stopped' = 'running';
  const sessions = new Set<string>();
  const registry = {
    get: async (name: string) => { if (!sessions.has(name)) throw Object.assign(new Error('missing'), { code: 'session_not_found' }); return { name, agent: 'codex' }; },
    create: vi.fn(async ({ name }: { name: string }) => { sessions.add(name); return { name }; }),
    delete: async (name: string) => { sessions.delete(name); },
    rename: async (name: string, next: string) => { sessions.delete(name); sessions.add(next); return { name: next }; },
    observeAgentLiveness: async () => state,
  };
  const guard = createNativeProviderProfileGuard({ homePath: home, registry });
  const input = { mutation: { type: 'start_login' as const, expectedRevision: 0, idempotencyKey: 'login_shared', harnessInstanceId: 'harness_codex', accountId: null, method: 'terminal' as const }, harness: { id: 'harness_codex', driverId: 'codex', harness: 'codex' as const, providerId: 'openai', modelId: 'gpt-5', installState: 'installed' as const } };
  const coordinator = () => createProviderTerminalLoginCoordinator({ homePath: home, registry, enabledHarnesses: ['codex'], profileGuard: guard });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const save = vi.fn(async () => { await gate; });
  const key = createProviderKeyVerifier({ providerId: 'openai', profile: 'codex', profileGuard: guard, fetchFn: async () => new Response('{}'), save });
  const saving = key({ harnessInstanceId: 'harness_codex', providerId: 'openai', apiKey: 'sk-fixture' });
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  await expect(coordinator().startLogin(input)).rejects.toThrow(); expect(registry.create).not.toHaveBeenCalled();
  const account: ProviderLifecycleAccount = { id: 'owner_codex', providerId: 'openai', authMethod: 'api_key', accessSourceId: 'owner_openai_profile', driverId: 'codex', harness: 'codex', installState: 'installed', authenticated: true, driverAccountCount: 1 };
  const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const lifecycle = createProviderCliAccountLifecycleCoordinator({ homePath: home, enabledDriverIds: ['codex'], profileGuard: guard, run });
  await expect(lifecycle.logout({ account, idempotencyKey: 'logout_shared' })).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
  release(); await saving;
  const attempt = await coordinator().startLogin(input);
  expect(await coordinator().startLogin(input)).toEqual(attempt); expect(registry.create).toHaveBeenCalledOnce();
  const restarted = createNativeProviderProfileGuard({ homePath: home, registry });
  const restartedKey = createProviderKeyVerifier({ providerId: 'openai', profile: 'codex', profileGuard: restarted, fetchFn: async () => new Response('{}'), save });
  await expect(restartedKey({ harnessInstanceId: 'second_codex', providerId: 'openai', apiKey: 'sk-fixture' })).rejects.toThrow();
  state = 'stopped'; await lifecycle.logout({ account, idempotencyKey: 'logout_shared' }); expect(run).toHaveBeenCalledOnce();
  state = 'running'; await lifecycle.logout({ account, idempotencyKey: 'logout_shared' }); expect(run).toHaveBeenCalledOnce(); // durable completed replay is read-only
});
it('does not forget a live managed installation when the gateway restarts', async () => {
  await fixture(); let state: 'running' | 'stopped' = 'running';
  const registry = { get: vi.fn(), listProfileSessions: async () => [{ name: 'provider-workflow-native-codex-install-12345678', agent: 'codex' }], observeAgentLiveness: async () => state };
  const restarted = createNativeProviderProfileGuard({ homePath: home, registry });
  await expect(restarted.run('codex', { kind: 'write' }, async () => {})).rejects.toThrow();
  state = 'stopped'; await expect(restarted.run('codex', { kind: 'write' }, async () => 'ready')).resolves.toBe('ready');
});
it('holds the shared native profile while historical logout waits for process completion', async () => {
  await fixture(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), observeAgentLiveness: vi.fn() } });
  const run = vi.fn(async () => { await gate; return { stdout: '', stderr: '' }; });
  const lifecycle = createProviderCliAccountLifecycleCoordinator({ homePath: home, enabledDriverIds: ['codex'], profileGuard: guard, run });
  const logout = lifecycle.logout({ account: { id: 'owner_codex', providerId: 'openai', authMethod: 'api_key', accessSourceId: 'owner_openai_profile', driverId: 'codex', harness: 'codex', installState: 'installed', authenticated: true, driverAccountCount: 1 }, idempotencyKey: 'logout_gate' });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  const save = vi.fn(); const fetchFn = vi.fn(async () => new Response('{}'));
  const verify = createProviderKeyVerifier({ providerId: 'openai', profile: 'codex', profileGuard: guard, fetchFn, save });
  await expect(verify({ harnessInstanceId: 'another_codex', providerId: 'openai', apiKey: 'sk-fixture' })).rejects.toThrow();
  expect(fetchFn).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); release(); await logout;
});
it('discovers a receipt-evicted historical native login and permits only its canonical recovery identity', async () => {
  await fixture(); const recoveryKey = 'b'.repeat(64);
  const name = `provider-auth-${BigInt(`0x${recoveryKey}`).toString(36).padStart(50, '0')}`;
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), listProfileSessions: async () => [{ name, agent: 'codex' }], observeAgentLiveness: async () => 'running' } });
  await expect(guard.run('codex', { kind: 'write' }, async () => 'key')).rejects.toThrow();
  expect(await guard.run('codex', { kind: 'login', recoveryKey }, async () => 'replay')).toBe('replay');
});
