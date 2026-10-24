import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createMatrixOpenAiConnectionService } from '../../packages/gateway/src/ai-providers/matrix-openai-connection.js';
import { createMatrixOpenAiSourceStore } from '../../packages/gateway/src/ai-providers/matrix-openai-source.js';
import { createNativeProviderProfileGuard } from '../../packages/gateway/src/ai-providers/native-provider-profile-guard.js';
import { readOwnerOpenAiKey } from '../../packages/gateway/src/ai-providers/owner-openai-key.js';
import { resolveManagedPiSelection } from '../../packages/gateway/src/chat/managed-pi-route.js';
const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(async home => { await rm(home, { recursive: true, force: true }); await rm(join(dirname(home), '.matrix-private', basename(home)), { recursive: true, force: true }); })); });
const request = { apiKey: 'sk-synthetic-explicit-api', expectedRevision: 0, expectedCredentialGeneration: null, idempotencyKey: 'connect-1' };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'matrix-openai-service-')); homes.push(home);
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { async get() { throw Object.assign(new Error('missing'), { code: 'session_not_found' }); }, async observeAgentLiveness() { return 'stopped'; } } });
  const store = createMatrixOpenAiSourceStore({ homePath: home, profileGuard: guard });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', owned_by: 'openai' }, { id: 'dall-e-3', object: 'model', owned_by: 'openai' }] }));
  let now = Date.now(); const changed = vi.fn();
  const service = createMatrixOpenAiConnectionService({ homePath: home, ownerId: 'owner', sourceStore: store, supports: { rootChat: true, recipeBots: true }, fetch: fetcher, now: () => now, ttlMs: 60000, onSourceChanged: changed });
  return { home, store, service, fetcher, changed, advance: () => { now += 60001; } };
}
it('does not import native OAuth, native API profiles or ambient OpenAI keys', async () => {
  const f = await fixture(); await mkdir(join(f.home, '.codex')); await writeFile(join(f.home, '.codex/auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'native-key-must-stay-native' }));
  expect(await f.service.observe('owner')).toMatchObject({ state: 'disconnected', enabled: false, models: [] });
  expect(await readOwnerOpenAiKey(f.home)).toMatchObject({ state: 'setup_required' }); expect(f.fetcher).not.toHaveBeenCalled(); await f.service.shutdown();
});
it.each(['openai-completions', 'openai-responses'] as const)('makes explicit %s selection reachable with canonical private generation and exact source checks', async api => {
  const f = await fixture(); const status = await f.service.connect('owner', request);
  expect(status).toMatchObject({ state: 'ready', revision: 1, providerId: 'openai', billingKind: 'api_key', models: [{ id: 'gpt-4.1' }] });
  expect(status.models).toHaveLength(1); expect(JSON.stringify(status)).not.toContain(request.apiKey);
  const selection = { instanceId: 'matrix_pi_openai_api', model: 'gpt-4.1', options: [{ id: 'connectionRevision', value: String(status.revision) }, { id: 'credentialGeneration', value: status.credentialGeneration! }, { id: 'api', value: api }] };
  const providers = { getSnapshot: vi.fn(async () => { throw new Error('funded fallback forbidden'); }) };
  const resolved = await resolveManagedPiSelection(selection, 'owner', { providers, matrixOpenAi: f.service } as never);
  expect(resolved).toMatchObject({ accessSourceId: 'owner_openai_key', openaiApi: { credentialGeneration: status.credentialGeneration, connectionRevision: 1 }, route: { api } });
  const binding = { ownerId: 'owner', kind: 'managed_chat', ...resolved } as never;
  expect(await f.service.credential(binding, new AbortController().signal)).toBe(request.apiKey);
  await expect(f.service.resolve(selection, 'other', 'interactive')).rejects.toThrow(); expect(providers.getSnapshot).not.toHaveBeenCalled();
  const [url, init] = f.fetcher.mock.calls[0]!; expect(String(url)).toBe('https://api.openai.com/v1/models'); expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${request.apiKey}`); expect(init!.signal).toBeInstanceOf(AbortSignal);
  const raw = await readFile(join(f.home, 'system/ai-providers/openai-key.json'), 'utf8'); expect(JSON.parse(raw)).toMatchObject({ credentialGeneration: status.credentialGeneration, apiKey: request.apiKey });
  f.advance(); expect(await f.service.revalidate(binding, new AbortController().signal)).toBe(false); await f.service.shutdown();
});
it('rejects stale generations, unsafe custody and revoked sources without selecting native/funded alternatives', async () => {
  const f = await fixture(); const first = await f.service.connect('owner', request);
  const selected = { instanceId: 'matrix_pi_openai_api', model: 'gpt-4.1', options: [{ id: 'connectionRevision', value: String(first.revision) }, { id: 'credentialGeneration', value: first.credentialGeneration! }, { id: 'api', value: 'openai-responses' }] };
  const old = { ownerId: 'owner', kind: 'managed_chat', ...await f.service.resolve(selected, 'owner', 'interactive') } as never;
  const current = await f.service.connect('owner', { ...request, apiKey: 'sk-synthetic-rotated-api', expectedRevision: 1, expectedCredentialGeneration: first.credentialGeneration, idempotencyKey: 'rotate' });
  expect(current.credentialGeneration).not.toBe(first.credentialGeneration); expect(await f.service.revalidate(old, new AbortController().signal)).toBe(false);
  await chmod(join(f.home, 'system/ai-providers/openai-key.json'), 0o644); expect(await f.service.observe('owner')).toMatchObject({ state: 'unavailable', models: [] });
  await f.service.shutdown();
});
it('owner-authenticated HTTP connection endpoints expose no key and preserve unavailable native/funded fallback', async () => {
  const { createMatrixOpenAiConnectionRoutes } = await import('../../packages/gateway/src/ai-providers/matrix-openai-connection-routes.js');
  const f = await fixture();
  let principal: { userId: string } | null = null;
  const snapshot = { getSnapshot: async () => ({ matrixOpenAiConnection: await f.service.observe('owner') }) };
  const routes = createMatrixOpenAiConnectionRoutes({ ownerId: 'owner', service: f.service, providerSnapshotReader: snapshot as never, getPrincipal: () => principal });
  const connect = () => routes.request('/matrix-connections/openai/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  expect((await connect()).status).toBe(401); principal = { userId: 'other' }; expect((await connect()).status).toBe(403); expect(f.fetcher).not.toHaveBeenCalled();
  principal = { userId: 'owner' }; const response = await connect(); expect(response.status).toBe(200); const text = await response.text(); expect(text).toContain('matrix_openai_api'); expect(text).not.toContain(request.apiKey);
  expect((await routes.request('/matrix-connections/openai/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(8193) })).status).toBe(413);
  await f.service.shutdown();
});
it('withdraws a canonical key replaced outside the writer even when its generation was copied', async () => {
  const f = await fixture(), status = await f.service.connect('owner', request);
  const selected = { instanceId: 'matrix_pi_openai_api', model: 'gpt-4.1', options: [{ id: 'connectionRevision', value: String(status.revision) }, { id: 'credentialGeneration', value: status.credentialGeneration! }, { id: 'api', value: 'openai-responses' }] };
  const bound = { ownerId: 'owner', kind: 'managed_chat', ...await f.service.resolve(selected, 'owner', 'interactive') } as never;
  const path = join(f.home, 'system/ai-providers/openai-key.json'); const key = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...key, apiKey: 'sk-privately-replaced-key' }), { mode: 0o600 });
  expect(await f.service.revalidate(bound, new AbortController().signal)).toBe(false);
  await expect(f.service.credential(bound, new AbortController().signal)).rejects.toThrow(); await f.service.shutdown();
});
