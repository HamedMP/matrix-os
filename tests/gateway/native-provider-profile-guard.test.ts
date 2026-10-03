import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createNativeProviderProfileGuard } from '../../packages/gateway/src/ai-providers/native-provider-profile-guard.js';
let home = '';
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });
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

it('does not forget a live managed installation when the gateway restarts', async () => {
  await fixture(); let state: 'running' | 'stopped' = 'running';
  const registry = { get: vi.fn(), listProfileSessions: async () => [{ name: 'provider-workflow-native-codex-install-12345678', agent: 'codex' }], observeAgentLiveness: async () => state };
  const restarted = createNativeProviderProfileGuard({ homePath: home, registry });
  await expect(restarted.run('codex', { kind: 'write' }, async () => {})).rejects.toThrow();
  state = 'stopped'; await expect(restarted.run('codex', { kind: 'write' }, async () => 'ready')).resolves.toBe('ready');
});
it('discovers a receipt-evicted historical native login and permits only its canonical recovery identity', async () => {
  await fixture(); const recoveryKey = 'b'.repeat(64);
  const name = `provider-auth-${BigInt(`0x${recoveryKey}`).toString(36).padStart(50, '0')}`;
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { get: vi.fn(), listProfileSessions: async () => [{ name, agent: 'codex' }], observeAgentLiveness: async () => 'running' } });
  await expect(guard.run('codex', { kind: 'write' }, async () => 'key')).rejects.toThrow();
  expect(await guard.run('codex', { kind: 'login', recoveryKey }, async () => 'replay')).toBe('replay');
});
