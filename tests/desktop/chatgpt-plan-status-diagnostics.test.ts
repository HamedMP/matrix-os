import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanVault } from '../../desktop/src/main/chatgpt-plan/vault';
import { createNativeChatgptPlanService } from '../../desktop/src/main/chatgpt-plan/service';
import { registerChatgptPlanIpc } from '../../desktop/src/main/ipc/chatgpt-plan';
import { createDesktopChatgptPlanClient } from '../../desktop/src/renderer/src/features/settings/local-chatgpt-plan-client';

const session = { runtimeSlot: 'primary', authGeneration: 1 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'plan-status-diagnostic-'));
  const safe = { isEncryptionAvailable: vi.fn(() => true), encryptString: (x: string) => Buffer.from(x), decryptString: vi.fn((x: Buffer) => x.toString()) };
  const vault = createPlanVault({ dir, safeStorage: safe });
  const live = { ...session, signedIn: true, userId: 'synthetic-owner', handle: 'synthetic-computer' };
  const auth = { getStatus: vi.fn(() => live), getToken: vi.fn(() => 'synthetic-token'), getGatewayOrigin: vi.fn(() => 'https://matrix.test') };
  const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error('no external work'); });
  const openBrowser = vi.fn();
  const service = createNativeChatgptPlanService({ vault, auth, fetchFn, openBrowser });
  cleanups.push(async () => { await service.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  registerChatgptPlanIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, service, event => event === 'main');
  const call = vi.fn((channel: string, input: unknown) => handlers.get(channel)!('main', input));
  const client = createDesktopChatgptPlanClient(session, () => true, call);
  const path = join(dir, `chatgpt-plan-${createHash('sha256').update(live.userId).digest('hex')}.bin`);
  return { dir, path, safe, vault, live, auth, fetchFn, openBrowser, service, handlers, call, client };
}
function diagnostic(client: ReturnType<typeof createDesktopChatgptPlanClient>) {
  // This accessor is deliberately exercised with all active dependencies disabled below.
  return (client as typeof client & { getLastDiagnostic(): Readonly<Record<string, unknown>> | null }).getLastDiagnostic();
}
async function failure(x: Awaited<ReturnType<typeof fixture>>, phase: string, category: string) {
  await expect(x.client.status(new AbortController().signal)).rejects.toThrow('ChatGPT connection is unavailable. Check again.');
  const receipt = diagnostic(x.client);
  expect(receipt).toMatchObject({ phase, category, correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/), at: expect.any(String) });
  expect(JSON.stringify(receipt)).not.toMatch(/synthetic|private|matrix\.test|token|ownerId|message|stack|cause/);
  expect(x.openBrowser).not.toHaveBeenCalled(); expect(x.fetchFn).not.toHaveBeenCalled();
  expect(Object.isFrozen(receipt)).toBe(true);
  return receipt;
}

describe('natural status service → IPC → renderer diagnostics', () => {
  it('carries protection failure and supports a pure bounded cached read without replay', async () => {
    const x = await fixture(); x.safe.isEncryptionAvailable.mockReturnValue(false);
    const receipt = await failure(x, 'vault_protection', 'protection_unavailable');
    const calls = [x.auth.getStatus.mock.calls.length, x.auth.getToken.mock.calls.length, x.call.mock.calls.length];
    const forbidden = [vi.spyOn(x.auth, 'getStatus'), vi.spyOn(x.auth, 'getToken'), vi.spyOn(x.vault, 'load'), vi.spyOn(x.vault, 'cleanup'), vi.spyOn(x.vault, 'save'), vi.spyOn(x.service, 'status'), vi.spyOn(x.service, 'refreshModels'), vi.spyOn(x.service, 'resume')];
    for (const spy of forbidden) spy.mockImplementation(() => { throw new Error('must not call'); });
    expect(diagnostic(x.client)).toBe(receipt); expect(diagnostic(x.client)).toBe(receipt);
    expect([x.auth.getStatus.mock.calls.length, x.auth.getToken.mock.calls.length, x.call.mock.calls.length]).toEqual(calls);
    for (const spy of forbidden) spy.mockRestore();
    x.safe.isEncryptionAvailable.mockReturnValue(true);
    expect((await x.client.status(new AbortController().signal)).state).toBe('disconnected');
    expect(diagnostic(x.client)).toBeNull();
  });

  it.each(['runtimeSlot', 'authGeneration'] as const)('reports only actually compared binding equality for stale %s', async key => {
    const x = await fixture();
    if (key === 'runtimeSlot') x.live.runtimeSlot = 'other'; else x.live.authGeneration = 2;
    const receipt = await failure(x, 'session_binding', 'stale_session');
    expect(receipt).toMatchObject({ runtimeSlotMatches: key !== 'runtimeSlot', authGenerationMatches: key !== 'authGeneration' });
    expect(receipt).not.toHaveProperty('ownerMatches'); expect(x.safe.decryptString).not.toHaveBeenCalled();
  });

  it.each(['vault_open', 'vault_read', 'vault_decrypt', 'vault_schema', 'vault_owner', 'vault_cleanup'] as const)('annotates %s at its natural failure without replay', async phase => {
    const x = await fixture();
    const record = await x.vault.load(x.live.userId);
    await x.vault.save(x.live.userId, record);
    if (phase === 'vault_open') { await fs.rm(x.path); await fs.symlink('missing-synthetic', x.path); }
    if (phase === 'vault_read') await fs.writeFile(x.path, Buffer.alloc(256 * 1024 + 1));
    if (phase === 'vault_decrypt') x.safe.decryptString.mockImplementation(() => { throw new Error('private path token account'); });
    if (phase === 'vault_schema') await fs.writeFile(x.path, '{"private":"invalid"}');
    if (phase === 'vault_owner') await fs.writeFile(x.path, JSON.stringify({ ...record, ownerId: 'different-owner' }));
    if (phase === 'vault_cleanup') {
      // A fresh vault has not swept; a non-directory blocks its natural cleanup.
      const blocked = join(x.dir, 'not-a-directory'); await fs.writeFile(blocked, 'x');
      const other = createPlanVault({ dir: blocked, safeStorage: x.safe });
      vi.spyOn(x.vault, 'load').mockImplementation(owner => other.load(owner));
    }
    const receipt = await failure(x, phase, phase === 'vault_owner' ? 'owner_mismatch' : phase === 'vault_schema' ? 'invalid_data' : 'unavailable');
    if (phase === 'vault_owner') expect(receipt).toHaveProperty('ownerMatches', false);
    if (phase === 'vault_decrypt') expect(x.safe.decryptString).toHaveBeenCalledOnce();
  });

  it('keeps catalog 503 as a valid error snapshot with safe diagnostic', async () => {
    const x = await fixture(), record = await x.vault.load(x.live.userId);
    const id = '00000000-0000-4000-8000-000000000001';
    record.activeAccountId = id;
    record.accounts = [{ id, clientId: 'fixture', subject: 'fixture', label: 'synthetic account', tokens: { clientId: 'fixture', subject: 'fixture', accessToken: 'synthetic', refreshToken: 'synthetic', idToken: 'synthetic', scopes: [], expiresAt: Date.now() + 3600000 } }];
    await x.vault.save(x.live.userId, record);
    x.fetchFn.mockResolvedValue(new Response('private upstream URL/account', { status: 503 }));
    const result = await x.client.status(new AbortController().signal);
    expect(result.state).toBe('error'); expect(result.account?.id).toBe(id);
    expect(diagnostic(x.client)).toMatchObject({ phase: 'catalog', category: 'unavailable', httpStatus: 503 });
    expect(x.fetchFn).toHaveBeenCalledOnce(); expect(x.openBrowser).not.toHaveBeenCalled();
  });

  it('preserves the existing peer-failure snapshot and observes only the attempted peer connection', async () => {
    const x = await fixture(), record = await x.vault.load(x.live.userId);
    const id = '00000000-0000-4000-8000-000000000001';
    record.activeAccountId = id;
    record.accounts = [{ id, clientId: 'fixture', subject: 'fixture', label: 'synthetic account', tokens: { clientId: 'fixture', subject: 'fixture', accessToken: 'synthetic', refreshToken: 'synthetic', idToken: 'synthetic', scopes: [], expiresAt: Date.now() + 3600000 } }];
    await x.vault.save(x.live.userId, record);
    const save = vi.spyOn(x.vault, 'save'), load = vi.spyOn(x.vault, 'load');
    x.fetchFn.mockResolvedValueOnce(Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list' }] }))
      .mockResolvedValueOnce(new Response('private peer detail', { status: 503 }));
    const result = await x.client.status(new AbortController().signal);
    expect(result.state).toBe('connected'); expect(result.bridgeConnected).toBe(false);
    expect(result.grant.enabled).toBe(false);
    expect(diagnostic(x.client)).toMatchObject({ phase: 'peer', category: 'unavailable', httpStatus: 503 });
    expect(x.fetchFn).toHaveBeenCalledTimes(2); expect(load).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled(); expect(x.openBrowser).not.toHaveBeenCalled();
  });

  it('rejects untrusted and malformed callers before owner operations', async () => {
    const x = await fixture();
    const handler = x.handlers.get('chatgpt-plan:status')!;
    await expect(handler('embed', session)).rejects.toThrow('invalid request');
    await expect(handler('main', { ...session, ownerId: 'forged' })).rejects.toThrow('invalid request');
    expect(x.auth.getStatus).not.toHaveBeenCalled(); expect(x.safe.isEncryptionAvailable).not.toHaveBeenCalled();
  });
});
