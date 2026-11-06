import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiProviderSnapshotV3 } from '@matrix-os/contracts';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: run }) }));
import { createClaudeTaskObserver } from '../../../packages/gateway/src/bots/claude-task-observation.js';
import { AiProviderService } from '../../../packages/gateway/src/ai-providers/service.js';

const help = '--restricted --tools --strict-mcp-config --setting-sources --output-format --permission-prompts';
const loggedOut = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const failure = (stdout: string, overrides: Record<string, unknown> = {}) => Object.assign(new Error('private-native-detail'), { code: 1, killed: false, signal: null, stdout, ...overrides });
let homePath: string;
const snapshot = { accessSources: [{ id: 'owner_anthropic_profile', state: 'ready', staleAfter: null, eligibleModelIds: ['model'] }], models: [{ id: 'model', displayName: 'Observed model', vendor: 'anthropic', status: 'available', eligibleAccessSourceIds: ['owner_anthropic_profile'] }] } as unknown as AiProviderSnapshotV3;
const providers = { getSnapshot: vi.fn(async () => snapshot) };
const observe = () => createClaudeTaskObserver({ homePath, providers })();

beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), 'matrix-claude-observation-'));
  run.mockReset(); providers.getSnapshot.mockClear();
  run.mockResolvedValueOnce({ stdout: '2.1.280 (Claude Code)' }).mockResolvedValueOnce({ stdout: help });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(homePath, { recursive: true, force: true }); });

describe('native Claude Bot readiness observation', () => {
  it('accepts current native subscription authentication with the real unprobed owner catalog', async () => {
    run.mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) });
    await writeFile(join(homePath, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account_test' } }));
    const service = new AiProviderService({ homePath, env: {}, exposeClaudeProfileAccount: true });
    try {
      expect((await service.getSnapshot()).accessSources.find(source => source.id === 'owner_anthropic_profile')?.state).toBe('unknown');
      const observed = await createClaudeTaskObserver({ homePath, providers: service })();
      expect(observed).toMatchObject({ available: true, fingerprint: createHash('sha256').update('account_test').digest('hex') });
      if (observed.available) expect(observed.models.length).toBeGreaterThan(0);
    } finally { service.close(); }
  });
  it('recognizes documented logged-out exit1 without reading a native profile or granting access', async () => {
    run.mockRejectedValueOnce(failure(loggedOut));
    await expect(observe()).resolves.toEqual({ available: false, reason: 'authentication_required' });
    expect(providers.getSnapshot).not.toHaveBeenCalled();
    expect(run).toHaveBeenLastCalledWith(expect.any(String), ['auth', 'status', '--json'], expect.objectContaining({ timeout: 5000, maxBuffer: 16 * 1024 }));
  });
  it('recognizes structured logged-out exit0', async () => {
    run.mockResolvedValueOnce({ stdout: loggedOut });
    await expect(observe()).resolves.toEqual({ available: false, reason: 'authentication_required' });
  });
  it('retains qualified connected observation and only exposes the hashed stable account and eligible models', async () => {
    run.mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.test' }) });
    await writeFile(join(homePath, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account_test' } }));
    await expect(observe()).resolves.toEqual({ available: true, fingerprint: createHash('sha256').update('account_test').digest('hex'), models: [{ id: 'model', displayName: 'Observed model' }] });
  });
  it('does not qualify an API key as native subscription authentication', async () => {
    run.mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) });
    await expect(observe()).resolves.toEqual({ available: false, reason: 'authentication_required' });
  });
  it.each(['setup_required', 'auth_required', 'expired', 'invalid', 'unavailable', 'disabled'])('does not override negative catalog state %s with native login', async state => {
    run.mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) });
    await writeFile(join(homePath, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account_test' } }));
    const canonical = structuredClone(snapshot); canonical.accessSources[0]!.state = state as typeof canonical.accessSources[0]['state'];
    await expect(createClaudeTaskObserver({ homePath, providers: { getSnapshot: async () => canonical } })()).resolves.toEqual({ available: false, reason: 'authentication_required' });
  });
  it('does not extend an expired unprobed catalog after native authentication', async () => {
    run.mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) });
    await writeFile(join(homePath, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account_test' } }));
    const canonical = structuredClone(snapshot); Object.assign(canonical.accessSources[0]!, { state: 'unknown', staleAfter: new Date(Date.now() - 1000).toISOString() });
    await expect(createClaudeTaskObserver({ homePath, providers: { getSnapshot: async () => canonical } })()).resolves.toEqual({ available: false, reason: 'authentication_required' });
  });
  it.each([
    ['invalid JSON', failure('not-json')],
    ['missing authentication fields', failure('{}')],
    ['string authentication flag', failure(JSON.stringify({ loggedIn: 'false', authMethod: 'none' }))],
    ['unexpected authentication method', failure(JSON.stringify({ loggedIn: false, authMethod: 'unknown' }))],
    ['contradictory successful authentication', failure(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))],
    ['unexpected exit', failure(loggedOut, { code: 2 })],
    ['missing executable', failure(loggedOut, { code: 'ENOENT' })],
    ['timeout', failure(loggedOut, { killed: true, signal: 'SIGTERM' })],
    ['signal termination', failure(loggedOut, { signal: 'SIGTERM' })],
    ['oversized stdout', failure(`${loggedOut}${' '.repeat(16 * 1024)}`)],
  ])('keeps %s unavailable without treating native stderr as login evidence', async (_name, error) => {
    run.mockRejectedValueOnce(error);
    await expect(observe()).resolves.toEqual({ available: false, reason: 'unsupported_runtime' });
    expect(providers.getSnapshot).not.toHaveBeenCalled();
  });
  it.each(['{}', 'null', '[]', 'not-json', JSON.stringify({ loggedIn: true, authMethod: 'unknown' })])('rejects malformed successful auth protocol %s', async stdout => {
    run.mockResolvedValueOnce({ stdout });
    await expect(observe()).resolves.toEqual({ available: false, reason: 'unsupported_runtime' });
  });
  it('rejects missing CLI flags before asking for authentication', async () => {
    run.mockReset().mockResolvedValueOnce({ stdout: '2.1.280 (Claude Code)' }).mockResolvedValueOnce({ stdout: help.replace('--restricted', '') });
    await expect(observe()).resolves.toEqual({ available: false, reason: 'unsupported_runtime' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('classifies a real native subprocess with logged-out output and timeout=%s', async hangs => {
    const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    run.mockReset().mockImplementation(promisify(native.execFile));
    await mkdir(join(homePath, 'bin'));
    const command = join(homePath, 'bin/claude');
    await writeFile(command, `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]==='--version') console.log('2.1.280 (Claude Code)');\nelse if(args[0]==='--help') console.log(${JSON.stringify(help)});\nelse {console.log(${JSON.stringify(loggedOut)}); ${hangs ? 'setTimeout(()=>{},60000);' : 'process.exitCode=1;'}}\n`);
    await chmod(command, 0o700);
    vi.stubEnv('MATRIX_NODE_PREFIX', homePath);
    await expect(observe()).resolves.toEqual({ available: false, reason: hangs ? 'unsupported_runtime' : 'authentication_required' });
    expect(providers.getSnapshot).not.toHaveBeenCalled();
  });
});
