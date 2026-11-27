import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCollectionRefusedError, type GoogleCollectionAdmission } from '../../packages/gateway/src/integrations/collection-hook.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import { createNativeGmailClient } from '../../packages/gateway/src/integrations/native-gmail/client.js';
import { createBotIntegrationClient, createLocalIntegrationTransport } from '../../packages/gateway/src/bots/integration-client.js';
import type { PlatformDb } from '../../packages/gateway/src/platform-db.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
const owner = 'owner_collection';
const account = '11111111-1111-4111-8111-111111111111';
const writeParams = { to: 'synthetic@example.invalid', subject: 'Synthetic', body: 'Synthetic' };
const actions = [
  { path: '/call', action: 'get_message', params: { messageId: 'message1' } },
  { path: '/read-call', action: 'get_message', params: { messageId: 'message1' } },
  { path: '/call', action: 'send_email', params: writeParams },
] as const;
function fixture(options: { native?: boolean; hook?: boolean; denied?: boolean; revokedDuringUsage?: boolean; service?: string; empty?: boolean } = {}) {
  const service = options.service ?? 'gmail', events: string[] = [];
  const state = { denied: options.denied ?? false, revoked: false };
  const row = { id: account, user_id: owner, service, status: 'active', account_label: 'Work', account_email: 'owner@example.invalid', pipedream_account_id: options.native ? `gmail_${account}` : 'apn_work' };
  const inventory = options.empty ? [] : [row];
  const provider = async (input: { url: string }) => { events.push('provider'); return input.url.endsWith('/profile') ? { emailAddress: 'owner@example.invalid' } : { id: 'private-result', snippet: 'private-mailbox-content' }; };
  const legacy = { proxyGet: vi.fn(provider), proxyPost: vi.fn(provider), listAccounts: vi.fn(async () => []), getAppInfo: vi.fn(async () => null),
    boundedGmailGet: vi.fn(async (input: { kind: string }) => { events.push('provider'); return input.kind === 'profile' ? { emailAddress: 'owner@example.invalid' } : { id: 'private-result' }; }) };
  const token = vi.fn(async () => { events.push('token'); return 'synthetic-token'; });
  const fetcher = vi.fn(async (url: string) => Response.json(await provider({ url })));
  const pipedream = options.native ? createNativeGmailClient({ legacy: legacy as unknown as PipedreamConnectClient, oauth: { token }, fetcher }) : legacy as unknown as PipedreamConnectClient;
  const db = { listConnectedServices: vi.fn(async () => inventory), getUserById: vi.fn(async () => { events.push('user'); return { pipedream_external_id: 'pd_owner' }; }),
    touchServiceUsage: vi.fn(async () => { events.push('usage'); if (options.revokedDuringUsage) state.revoked = true; }),
    connectService: vi.fn(async (input: { service: string; pipedreamAccountId: string; accountLabel: string; accountEmail?: string }) => {
      events.push('upsert'); const connected = { ...row, id: inventory.length ? '22222222-2222-4222-8222-222222222222' : account, service: input.service,
        pipedream_account_id: input.pipedreamAccountId, account_label: input.accountLabel, account_email: input.accountEmail ?? null };
      inventory.push(connected as typeof row); return { ...connected, inserted: true };
    }) };
  const release = vi.fn(async () => { events.push('release'); if (state.revoked) throw new Error('synthetic private policy refusal'); });
  const admit = vi.fn<GoogleCollectionAdmission['admit']>(async () => { events.push('admit'); if (state.denied) throw new Error('synthetic private policy refusal'); return { release }; });
  const app = createIntegrationRoutes({ db: db as unknown as PlatformDb, pipedream, webhookSecret: 'synthetic', resolveUserId: async () => owner,
    ...(options.hook === false ? {} : { googleCollection: { admit } }) });
  const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => app.request(path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ service, label: 'Work', connectionId: account, ...body }) });
  return { app, post, db, inventory, row, events, state, legacy, token, fetcher, admit, release };
}
afterEach(() => vi.restoreAllMocks());
describe('trusted Gmail collection route boundary', () => {
  it.each(actions.flatMap(action => [false, true].map(native => ({ ...action, native }))))('refuses $path/$action before any mailbox or credential call (native=$native)', async ({ native, path, action, params }) => {
    const f = fixture({ native, denied: true }); const response = await f.post(path, { action, params });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'Integration service unavailable' });
    expect(f.admit).toHaveBeenCalledExactlyOnceWith(expect.anything(), { id: account, user_id: owner, service: 'gmail', status: 'active' }, path);
    expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.legacy.proxyGet).not.toHaveBeenCalled(); expect(f.legacy.proxyPost).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
  it.each(actions.flatMap(action => [false, true].map(native => ({ ...action, native }))))('withholds $path/$action if authority changes during usage accounting (native=$native)', async ({ native, path, action, params }) => {
    const f = fixture({ native, revokedDuringUsage: true }); const response = await f.post(path, { action, params });
    expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/private-result|private-mailbox|synthetic private/);
    expect(f.events.filter(event => ['admit', 'provider', 'usage', 'release'].includes(event))).toEqual(['admit', 'provider', 'usage', 'release']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each(actions.flatMap(action => [false, true].map(native => ({ ...action, native }))))('returns $path/$action only after successful admission and release (native=$native)', async ({ native, path, action, params }) => {
    const f = fixture({ native }); const response = await f.post(path, { action, params });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { id: 'private-result' } });
    expect(f.events.filter(event => ['admit', 'provider', 'usage', 'release'].includes(event))).toEqual(['admit', 'provider', 'usage', 'release']);
    expect(f.release).toHaveBeenCalledTimes(1);
    if (native) { expect(f.token).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.legacy.proxyGet).not.toHaveBeenCalled(); expect(f.legacy.proxyPost).not.toHaveBeenCalled(); }
    else { expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); }
  });
  it.each(['/call', '/read-call'])('waits for usage completion before release on $0', async path => {
    const f = fixture(); let finish!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.db.touchServiceUsage.mockImplementation(async () => { entered(); await held; f.state.revoked = true; });
    const pending = f.post(path, { action: 'get_message', params: { messageId: 'message1' } });
    await started; expect(f.release).not.toHaveBeenCalled(); finish();
    expect((await pending).status).toBe(503); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each(['/call', '/read-call'].flatMap(path => ['owner', 'status'].map(changed => ({ path, changed }))))('rejects a noncanonical $changed snapshot before admission on $path', async ({ path, changed }) => {
    const f = fixture(); if (changed === 'owner') f.row.user_id = 'other'; else f.row.status = 'revoked';
    expect((await f.post(path, { action: 'get_message', params: { messageId: 'message1' } })).status).toBe(503);
    expect(f.admit).not.toHaveBeenCalled(); expect(f.legacy.proxyGet).not.toHaveBeenCalled();
  });
  it('fails closed before provider dispatch when admission returns an invalid lease', async () => {
    const f = fixture(); f.admit.mockResolvedValue({ release: null } as never);
    expect((await f.post('/call', { action: 'get_message', params: { messageId: 'message1' } })).status).toBe(503);
    expect(f.legacy.proxyGet).not.toHaveBeenCalled();
  });
  it.each(['admit', 'release'] as const)('keeps typed %s refusal generic', async phase => {
    const f = fixture(); if (phase === 'admit') f.admit.mockRejectedValue(new GoogleCollectionRefusedError());
    else f.release.mockRejectedValue(new GoogleCollectionRefusedError());
    const response = await f.post('/call', { action: 'get_message', params: { messageId: 'message1' } });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'Integration service unavailable' });
  });
  it('rejects an empty canonical account even without a caller account pin', async () => {
    const f = fixture(); f.row.id = '';
    expect((await f.post('/call', { action: 'get_message', params: { messageId: 'message1' }, connectionId: undefined })).status).toBe(503);
    expect(f.admit).not.toHaveBeenCalled(); expect(f.legacy.proxyGet).not.toHaveBeenCalled();
  });
  it.each(['/call', '/read-call'])('preserves exact request bytes for server signature verification on $0', async path => {
    const f = fixture(); const body = ' { "service" : "gmail", "label":"Work", "connectionId":"' + account + '", "action":"get_message", "params": {"messageId":"message1"} } ';
    f.admit.mockImplementation(async c => { expect(await c.req.text()).toBe(body); return { release: f.release }; });
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(response.status).toBe(200); expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it('never treats a release refusal as a best-effort usage error', async () => {
    const f = fixture(); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    f.db.touchServiceUsage.mockImplementation(async () => { f.events.push('usage'); f.state.revoked = true; throw new Error('synthetic usage failure'); });
    const response = await f.post('/call', { action: 'get_message', params: { messageId: 'message1' } });
    expect(response.status).toBe(503); expect(f.release).toHaveBeenCalledTimes(1); expect(await response.text()).not.toContain('private-result');
  });
  it('preserves unknown-effect semantics when a write succeeded before release refusal', async () => {
    const f = fixture({ revokedDuringUsage: true }); const client = createBotIntegrationClient(createLocalIntegrationTransport(f.app));
    await expect(client.call(owner, { service: 'gmail', action: 'send_email', label: 'Work', connectionId: account, params: writeParams, read: false })).rejects.toMatchObject({ code: 'unavailable', effectUnknown: true });
    expect(f.legacy.proxyPost).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each(['/call', '/read-call'])('preserves non-Gmail flows on $0', async path => {
    const f = fixture({ service: 'github', denied: true }); const response = await f.post(path, { action: 'list_repos', params: {} });
    expect(response.status).toBe(200); expect(f.admit).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.legacy.proxyGet).toHaveBeenCalledTimes(1);
  });
  it.each(['/call', '/read-call'])('keeps legacy Gmail unchanged without an installed hook on $0', async path => {
    const f = fixture({ hook: false }); const response = await f.post(path, { action: 'get_message', params: { messageId: 'message1' } }, { 'x-matrix-google-processing': 'caller-controlled' });
    expect(response.status).toBe(200); expect(f.admit).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
  it.each(['/call', '/read-call'])('validates final exact account/action/parameters before admission on $0', async path => {
    const f = fixture();
    for (const body of [{ connectionId: 'other', action: 'get_message', params: { messageId: 'message1' } }, { action: 'unknown', params: {} }, { action: 'get_message', params: {} }]) expect((await f.post(path, body)).status).toBeLessThan(500);
    expect(f.admit).not.toHaveBeenCalled(); expect(f.legacy.proxyGet).not.toHaveBeenCalled();
  });
  it('cannot install or bypass the server dependency through request fields or headers', async () => {
    const f = fixture({ denied: true });
    const response = await f.post('/call', { action: 'get_message', params: { messageId: 'message1' }, googleCollection: { approved: true }, ownerId: 'other' }, { 'x-matrix-google-processing': 'approved' });
    expect(response.status).toBe(503); expect(f.admit).toHaveBeenCalledTimes(1); expect(f.legacy.proxyGet).not.toHaveBeenCalled();
  });
  it('does not perform optional Gmail profile enrichment before admitting a synchronized account', async () => {
    const f = fixture({ empty: true, denied: true }); f.legacy.listAccounts.mockResolvedValue([{ id: 'apn_new', app: 'gmail' }] as never);
    const response = await f.post('/call', { action: 'get_message', params: { messageId: 'message1' }, label: undefined, connectionId: undefined });
    expect(response.status).toBe(503); expect(f.db.connectService).toHaveBeenCalledTimes(1); expect(f.legacy.proxyGet).not.toHaveBeenCalled();
    expect(f.admit).toHaveBeenCalledExactlyOnceWith(expect.anything(), { id: account, user_id: owner, service: 'gmail', status: 'active' }, '/call');
  });
  it('preserves optional sync-on-miss profile enrichment when no hook is installed', async () => {
    const f = fixture({ empty: true, hook: false }); f.legacy.listAccounts.mockResolvedValue([{ id: 'apn_new', app: 'gmail' }] as never);
    const response = await f.post('/call', { action: 'get_message', params: { messageId: 'message1' }, label: undefined, connectionId: undefined });
    expect(response.status).toBe(200); expect(f.legacy.proxyGet).toHaveBeenCalledTimes(2);
    expect(f.db.connectService).toHaveBeenCalledWith(expect.objectContaining({ accountEmail: 'owner@example.invalid' }));
    expect(f.admit).not.toHaveBeenCalled();
  });
  it('skips unrelated Gmail profile enrichment while synchronizing a non-Gmail call', async () => {
    const f = fixture({ empty: true, service: 'github' }); f.legacy.listAccounts.mockResolvedValue([{ id: 'apn_gmail', app: 'gmail' }, { id: 'apn_github', app: 'github', email: 'github@example.invalid' }] as never);
    const response = await f.post('/call', { action: 'list_repos', params: {}, label: undefined, connectionId: undefined });
    expect(response.status).toBe(200); expect(f.legacy.proxyGet).toHaveBeenCalledTimes(1); expect(f.legacy.proxyGet.mock.calls[0]![0].url).toBe('https://api.github.com/user/repos'); expect(f.admit).not.toHaveBeenCalled();
  });
  it.each(['/call', '/read-call'])('settles the admitted lease once even when a provider fails on $0', async path => {
    const f = fixture(); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    f.legacy.proxyGet.mockRejectedValue(new Error('synthetic provider failure'));
    expect((await f.post(path, { action: 'get_message', params: { messageId: 'message1' } })).status).toBe(502);
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.db.touchServiceUsage).not.toHaveBeenCalled();
  });
  it('guards Jev profile lookup and releases only after its usage await without claiming onward qualification', async () => {
    const f = fixture({ revokedDuringUsage: true }); const binding = { service: 'gmail', connectionId: account, accountLabel: 'Work', expectedEmail: 'owner@example.invalid' };
    const response = await f.post('/read-call', { action: 'get_thread_ids', params: { threadId: 'thread1' }, binding });
    expect(response.status).toBe(503); expect(f.events.filter(event => ['admit', 'provider', 'usage', 'release'].includes(event))).toEqual(['admit', 'provider', 'provider', 'usage', 'release']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('refuses Jev collection before its first live profile lookup', async () => {
    const f = fixture({ denied: true }); const binding = { service: 'gmail', connectionId: account, accountLabel: 'Work', expectedEmail: 'owner@example.invalid' };
    expect((await f.post('/read-call', { action: 'get_thread_ids', params: { threadId: 'thread1' }, binding })).status).toBe(503);
    expect(f.admit).toHaveBeenCalledTimes(1); expect(f.legacy.boundedGmailGet).not.toHaveBeenCalled();
  });
  it('rejects invalid Jev workflow actions and bindings before consuming admission or reading the profile', async () => {
    const f = fixture(); const binding = { service: 'gmail', connectionId: account, accountLabel: 'Work', expectedEmail: 'owner@example.invalid' };
    expect((await f.post('/read-call', { action: 'get_message', params: { messageId: 'message1' }, binding: { ...binding, connectionId: 'other' } })).status).toBe(403);
    expect((await f.post('/read-call', { action: 'list_labels', params: {}, binding })).status).toBe(403);
    expect(f.admit).not.toHaveBeenCalled(); expect(f.legacy.boundedGmailGet).not.toHaveBeenCalled();
  });
});
