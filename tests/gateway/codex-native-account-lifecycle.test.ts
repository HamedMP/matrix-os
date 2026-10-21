import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, expect, it, vi } from 'vitest';
import { resolveCodexNativeExecutable } from '../../packages/gateway/src/ai-providers/codex-native-terminal-command.js';
import { AiProviderService } from '../../packages/gateway/src/ai-providers/service.js';
import { ProviderSettingsStore } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import { createDefaultProviderCliAccountLifecycleCoordinator } from '../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js';
import { createNativeProviderProfileGuard } from '../../packages/gateway/src/ai-providers/native-provider-profile-guard.js';
import { normalizeCodexNativeAccountMetadata } from '../../packages/gateway/src/ai-providers/codex-native-account-metadata.js';
import { bindNativeAccountMetadata } from '../../packages/gateway/src/ai-providers/native-account-metadata-binding.js';
// These lifecycle fixtures inject command execution and identity readers. Binary
// discovery has its own tests; do not depend on a developer's installed Codex.
vi.mock('../../packages/gateway/src/ai-providers/codex-native-terminal-command.js', () => ({
  resolveCodexNativeExecutable: vi.fn(),
}));
beforeEach(() => { vi.mocked(resolveCodexNativeExecutable).mockReset().mockReturnValue('/fixture/bin/codex'); });

it.each(['logout', 'drift'] as const)('guards native Codex %s while preserving independent Matrix AI state', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'codex-lifecycle-fixture-'));
  const homePath = join(root, 'home'); await mkdir(homePath);
  let principal = 'native@example.invalid', loggedIn = true;
  const readMetadata = async () => {
    if (!loggedIn) return null;
    const expected = principal;
    return bindNativeAccountMetadata(normalizeCodexNativeAccountMetadata({ account: { type: 'chatgpt', email: expected } }, {}, new Date())!, async () => loggedIn && principal === expected, expected);
  };
  const guard = createNativeProviderProfileGuard({ homePath, registry: { listProfileSessions: async () => [], get: async () => { throw Object.assign(new Error('missing'), { code: 'session_not_found' }); }, observeAgentLiveness: async () => 'stopped' } });
  const nativeRun = vi.fn(async () => { loggedIn = false; return { stdout: '', stderr: '' }; });
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ['codex'], profileGuard: guard, run: nativeRun, readCodexAccountUnderLease: readMetadata });
  const service = new AiProviderService({ homePath, env: {}, driverInventory: async () => [{ id: 'codex', displayName: 'Codex', kind: 'cli', installState: 'installed', health: 'ready', setupActions: [], capabilities: ['tools'] }] });
  try {
    const store = new ProviderSettingsStore({ homePath, privateRootPath: join(root, 'private'), providerSnapshotReader: service, accountLifecycle: lifecycle, codexNativeAccountMetadataReader: readMetadata });
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(snapshot.supportedActions).toContain("logout_account");
    const independent = join(root, 'matrix-ai-grant.json');
    await writeFile(independent, JSON.stringify({ source: 'matrix_ai', grant: 'synthetic-independent-grant', enabled: true }));
    const original = guard.run.bind(guard);
    guard.run = async (profile, admission, operation) => { if (mode === 'drift') principal = 'replacement@example.invalid'; return original(profile, admission, operation); };
    const mutation = { type: 'logout_account' as const, accountId: 'owner_codex', expectedRevision: snapshot.revision, idempotencyKey: 'codex-logout' };
    if (mode === 'drift') { await expect(store.mutate(mutation)).rejects.toMatchObject({ code: 'lifecycle_unavailable' }); expect(nativeRun).not.toHaveBeenCalled(); }
    else { await store.mutate(mutation); await store.mutate(mutation); expect(nativeRun).toHaveBeenCalledOnce(); expect(nativeRun).toHaveBeenCalledWith('/fixture/bin/codex', ['logout'], expect.any(Object)); }
    expect(JSON.parse(await readFile(independent, 'utf8'))).toEqual({ source: 'matrix_ai', grant: 'synthetic-independent-grant', enabled: true });
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(['signed-out', 'new-account', 'unknown', 'error', 'missing-executable', 'timeout', 'non-error'] as const)('removes signed-out native metadata only with authoritative absence: %s', async mode => {
  const homePath = await mkdtemp(join(tmpdir(), 'codex-remove-fixture-'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (mode === 'missing-executable') vi.mocked(resolveCodexNativeExecutable).mockImplementation(() => { throw new Error('/private/synthetic-secret missing executable'); });
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args.join(' ') !== 'login status') throw new Error('Unexpected mutating command');
    if (mode === 'new-account') return { stdout: 'Logged in using ChatGPT', stderr: '' };
    if (mode === 'non-error') throw { message: 'synthetic-secret', stderr: '/private/synthetic-secret' };
    if (mode === 'timeout') throw Object.assign(new Error('/private/synthetic-secret'), { name: 'synthetic-secret', code: 'ETIMEDOUT', stderr: 'synthetic-secret' });
    throw Object.assign(new Error('/private/synthetic-secret'), { code: mode === 'error' ? 'ENOENT' : 1, stdout: '', stderr: mode === 'signed-out' ? 'Not logged in\n' : 'Unavailable' });
  });
  const guard = createNativeProviderProfileGuard({ homePath, registry: { listProfileSessions: async () => [], get: async () => { throw Object.assign(new Error('missing'), { code: 'session_not_found' }); }, observeAgentLiveness: async () => 'stopped' } });
  const coordinator = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ['codex'], profileGuard: guard, run, readCodexAccountUnderLease: async () => null });
  const account = { id: 'owner_codex', providerId: 'openai', authMethod: 'terminal', accessSourceId: 'owner_openai_profile', driverId: 'codex', harness: 'codex', installState: 'installed', authenticated: false, driverAccountCount: 1 } as const;
  try {
    if (mode === 'signed-out') {
      await coordinator.remove({ account, idempotencyKey: 'remove-signed-out' });
      await coordinator.remove({ account, idempotencyKey: 'remove-signed-out' });
      expect(run).toHaveBeenCalledOnce();
    } else await expect(coordinator.remove({ account, idempotencyKey: 'remove-signed-out' })).rejects.toThrow('unavailable');
    if (mode === 'missing-executable') expect(run).not.toHaveBeenCalled();
    else expect(run).toHaveBeenCalledWith('/fixture/bin/codex', ['login', 'status'], expect.objectContaining({ cwd: homePath, timeoutMs: 10000, maxOutputBytes: 65536 }));
    expect(run.mock.calls.some(([, args]) => args.includes('logout'))).toBe(false);
    if (mode === 'signed-out' || mode === 'new-account') expect(warning).not.toHaveBeenCalled();
    else expect(warning).toHaveBeenCalledWith('[provider-lifecycle] Native sign-out status unavailable:', {
      phase: mode === 'missing-executable' ? 'resolve_executable' : 'login_status',
      code: mode === 'timeout' ? 'ETIMEDOUT' : mode === 'error' ? 'ENOENT' : mode === 'unknown' ? 1 : 'unknown',
    });
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/synthetic-secret|\/private|Not logged in|Unavailable/);
  } finally { warning.mockRestore(); await rm(homePath, { recursive: true, force: true }); }
});

it('checks real store dependencies before signed-out native removal and never logs out', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'codex-remove-store-'));
  let active = 1;
  const run = vi.fn(async () => { throw Object.assign(new Error('Signed out'), { code: 1, stdout: '', stderr: 'Not logged in\n' }); });
  const guard = createNativeProviderProfileGuard({ homePath, registry: { listProfileSessions: async () => [], get: async () => { throw Object.assign(new Error('missing'), { code: 'session_not_found' }); }, observeAgentLiveness: async () => 'stopped' } });
  const service = new AiProviderService({ homePath, env: {}, driverInventory: async () => [{ id: 'codex', displayName: 'Codex', kind: 'cli', installState: 'installed', health: 'ready', setupActions: [], capabilities: ['tools'] }] });
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ['codex'], profileGuard: guard, run, readCodexAccountUnderLease: async () => null });
  try {
    const store = new ProviderSettingsStore({ homePath, providerSnapshotReader: service, accountLifecycle: lifecycle, codexNativeAccountMetadataReader: async () => null,
      dependencyCoordinator: { getAccountDependencies: async () => ({ activeChatCount: active, resumableChatCount: 0, harnessInstanceCount: 0 }), reassignDependencies: async () => {} } });
    const snapshot = await store.getSnapshot();
    const mutation = { type: 'remove_account' as const, confirmation: 'remove_account' as const, accountId: 'owner_codex', expectedRevision: snapshot.revision, idempotencyKey: 'remove-after-clear', dependencyGuard: { activeChatCount: 1, resumableChatCount: 0, harnessInstanceCount: 0 } };
    await expect(store.mutate(mutation)).rejects.toMatchObject({ code: 'account_in_use' });
    expect(run).not.toHaveBeenCalled();
    active = 0;
    await store.mutate({ ...mutation, dependencyGuard: { ...mutation.dependencyGuard, activeChatCount: 0 } });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith('/fixture/bin/codex', ['login', 'status'], expect.any(Object));
  } finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
});
