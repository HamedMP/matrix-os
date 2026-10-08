import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), piClose: vi.fn(async () => {}), hermesClose: vi.fn(async () => {}) }));
vi.mock('../../packages/gateway/src/app-ai/pi-sdk-completion.js', () => ({ createPiSdkAppCompletion: () => ({ close: mocks.piClose }) }));
vi.mock('../../packages/gateway/src/app-ai/hermes-completion.js', () => ({ createHermesAppCompletion: () => ({ close: mocks.hermesClose }) }));
vi.mock('../../packages/gateway/src/request-principal.js', () => ({ requireRequestPrincipal: () => ({ userId: 'owner' }) }));
vi.mock('../../packages/gateway/src/kernel-credentials.js', () => ({ resolveKernelCredentialSources: async () => ({ selectedAccessSourceId: 'owner_anthropic_key' }), buildKernelCredentialLaunch: async () => ({ env: { ANTHROPIC_API_KEY: 'synthetic' } }) }));
vi.mock('@matrix-os/kernel', () => ({ generateAppText: mocks.generate, DEFAULT_KERNEL_MODEL: 'claude-opus-5', DEFAULT_KERNEL_EFFORT: 'high' }));
import { registerAppAiCapabilities } from '../../packages/gateway/src/server/app-capabilities.js';
import { createAppAiLifecycle } from '../../packages/gateway/src/server/app-ai-lifecycle.js';
import { projectChatGptPlanSnapshot } from '../../packages/gateway/src/app-ai/chatgpt-plan-projection.js';
import { createFundedAdmissionQueue } from '../../packages/gateway/src/funded-ai/admission-queue.js';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let homePath: string;
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), 'app-ai-lifecycle-')); await mkdir(join(homePath, 'system')); vi.clearAllMocks(); });
afterEach(async () => { vi.useRealTimers(); await rm(homePath, { recursive: true, force: true }); });
const route = { harnessId: 'matrix_ai', accountId: null, accessSourceId: 'matrix_cloudflare', modelId: '@cf/zai-org/glm-5.3-flash' };
const canonical = () => ({ accessSources: [{ id: route.accessSourceId, state: 'ready', checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60000).toISOString(), eligibleModelIds: [route.modelId] }], models: [{ id: route.modelId, status: 'current', eligibleAccessSourceIds: [route.accessSourceId] }] });
const post = (app: Hono, selection: unknown = route, signal?: AbortSignal) => app.request('/api/bridge/ai', { method: 'POST', signal, body: JSON.stringify({ app: 'brain', prompt: 'text', ...(selection ? { route: selection } : {}) }) });
it('aborts funded HTTP and waits for real cancellation cleanup before closing dependencies, while rejecting new work', async () => {
  await writeFile(join(homePath, 'system/app-ai.json'), JSON.stringify({ apps: ['brain'] }));
  const entered = deferred<void>(); const release = deferred<void>(); let signal!: AbortSignal; let drained = false;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    signal = init!.signal!; entered.resolve();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => { void release.promise.then(() => { drained = true; reject(new Error('cancelled')); }); }, { once: true }));
  });
  const fundedAdmission = createFundedAdmissionQueue(); const closeAdmission = vi.spyOn(fundedAdmission, 'close');
  const app = new Hono(); const runtime = registerAppAiCapabilities(app, { homePath, ownerIds: ['owner'], hermesRuntimeSource: {} as never, providerSnapshotReader: { getSnapshot: async () => canonical() as never }, fundedCredentialProvider: { enabled: true, getCredential: async () => ({ token: 'synthetic', relayBaseUrl: 'https://relay.example.test' }) } as never, fundedAdmission, fetchImpl });
  const client = new AbortController(); const pending = post(app, route, client.signal); await entered.promise;
  let closed = false; const closing = runtime.close().then(() => { fundedAdmission.close(); closed = true; });
  try {
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 200 });
    expect(closed).toBe(false); expect(drained).toBe(false); expect(closeAdmission).not.toHaveBeenCalled();
    expect((await post(app)).status).toBe(503); expect((await app.request('/api/bridge/ai/routes?app=brain')).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledOnce();
    release.resolve(); await closing; expect(drained).toBe(true); expect(closeAdmission).toHaveBeenCalledOnce(); expect((await pending).status).toBe(503);
  } finally { client.abort(); release.resolve(); await pending; await closing; }
});
it('aborts legacy Claude completion and awaits its real cleanup instead of only native executors', async () => {
  await writeFile(join(homePath, 'system/app-ai.json'), JSON.stringify({ apps: ['brain'], model: 'claude-sonnet-5' }));
  const entered = deferred<void>(); const release = deferred<void>(); let signal!: AbortSignal;
  mocks.generate.mockImplementation(async (options: { signal: AbortSignal }) => { signal = options.signal; entered.resolve(); await release.promise; signal.throwIfAborted(); return { text: 'late result' }; });
  const app = new Hono(); const runtime = registerAppAiCapabilities(app, { homePath, ownerIds: ['owner'], hermesRuntimeSource: {} as never });
  const client = new AbortController(); const pending = post(app, null, client.signal); await entered.promise;
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  try { await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 200 }); expect(closed).toBe(false); release.resolve(); await closing; expect((await pending).status).toBe(503); }
  finally { client.abort(); release.resolve(); await pending; await closing; }
});
it.each(['reading', 'late headers'])('waits for funded response body cancellation to drain at %s', async mode => {
  await writeFile(join(homePath, 'system/app-ai.json'), JSON.stringify({ apps: ['brain'] }));
  const entered = deferred<void>(); const headers = deferred<Response>(); const cancelStarted = deferred<void>(); const release = deferred<void>();
  let drained = false;
  const cancel = vi.fn(async () => { cancelStarted.resolve(); await release.promise; drained = true; });
  const body = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel }, { highWaterMark: 0 });
  const fetchImpl = vi.fn(async () => { if (mode === 'late headers') { entered.resolve(); return headers.promise; } return new Response(body); });
  const app = new Hono(); const runtime = registerAppAiCapabilities(app, { homePath, ownerIds: ['owner'], hermesRuntimeSource: {} as never, providerSnapshotReader: { getSnapshot: async () => canonical() as never }, fundedCredentialProvider: { enabled: true, getCredential: async () => ({ token: 'synthetic', relayBaseUrl: 'https://relay.example.test' }) } as never, fetchImpl });
  const pending = post(app); await entered.promise; let closed = false; const closing = runtime.close().then(() => { closed = true; });
  if (mode === 'late headers') headers.resolve(new Response(body));
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { timeout: 200 }); await cancelStarted.promise;
    await new Promise(resolve => setTimeout(resolve, 10)); expect(closed).toBe(false); expect(drained).toBe(false);
    release.resolve(); await closing; expect(drained).toBe(true); expect((await pending).status).toBe(503);
  } finally { release.resolve(); await pending; await closing; }
});
it('retains paired authority inference through cancellation even after its app response has returned', async () => {
  await writeFile(join(homePath, 'system/app-ai.json'), JSON.stringify({ apps: ['brain'] }));
  const selected = { harnessId: 'matrix_chatgpt_plan', accountId: 'own-account', accessSourceId: 'matrix_chatgpt_plan', modelId: 'gpt-account-model' };
  const source = { id: 'matrix_chatgpt_plan', providerId: 'openai', executionKind: 'direct_pi' as const, availability: 'available' as const, accountId: selected.accountId, models: [{ id: selected.modelId, displayName: 'Model' }], authorization: { revision: 4, enabled: true, background: false }, coordinatorFunding: 'subscription' as const };
  const snapshot = projectChatGptPlanSnapshot({ contractVersion: 3, revision: 0, refreshedAt: new Date().toISOString(), accessSources: [], accounts: [], drivers: [], instances: [], models: [], active: { providerInstanceId: null, accessSourceId: null, modelId: null } }, source);
  const entered = deferred<void>(); const release = deferred<void>(); let signal!: AbortSignal;
  const authority = {
    observe: async () => source,
    resolve: async () => ({ accessSourceId: selected.accessSourceId, route: { api: 'openai-responses' as const, modelId: selected.modelId, input: ['text'] as ['text'], contextWindow: 128000, maxOutputTokens: 8192 }, subscription: { accountId: selected.accountId, peerId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2', computerId: 'computer-own', grantRevision: 4 } }),
    revalidate: async () => true,
    infer: vi.fn(async (_binding: unknown, _body: string, input: AbortSignal) => { signal = input; entered.resolve(); await release.promise; input.throwIfAborted(); return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }; }),
  };
  const app = new Hono(); const runtime = registerAppAiCapabilities(app, { homePath, ownerIds: ['owner'], hermesRuntimeSource: {} as never, providerSnapshotReader: { getSnapshot: async () => snapshot }, chatGptPlanSource: () => ({ ownerId: 'owner', authority }) });
  const pending = post(app, selected); await entered.promise; let closed = false; const closing = runtime.close().then(() => { closed = true; });
  try {
    expect(signal.aborted).toBe(true); expect((await pending).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 10)); expect(closed).toBe(false);
    release.resolve(); await closing; expect(authority.infer).toHaveBeenCalledOnce();
  } finally { release.resolve(); await pending; await closing; }
});
it('caps actual tracked work before invoking it and rejects admission after shutdown', async () => {
  const lifecycle = createAppAiLifecycle(); const release = deferred<void>(); const operation = vi.fn(async () => release.promise);
  const pending = Array.from({ length: 16 }, () => lifecycle.track(operation));
  await expect(lifecycle.track(operation)).rejects.toThrow('App AI is unavailable'); expect(operation).toHaveBeenCalledTimes(16);
  const closing = lifecycle.close(); await expect(lifecycle.track(operation)).rejects.toThrow();
  release.resolve(); await Promise.all(pending); await closing; expect(operation).toHaveBeenCalledTimes(16);
});
it('bounds shutdown without pretending an ignored cancellation has drained', async () => {
  const lifecycle = createAppAiLifecycle(); const release = deferred<void>(); const pending = lifecycle.track(async () => release.promise);
  await Promise.resolve(); vi.useFakeTimers();
  const closing = lifecycle.close(); const failed = expect(closing).rejects.toThrow('App AI shutdown drain unavailable');
  await vi.advanceTimersByTimeAsync(5000); await failed;
  await expect(lifecycle.track(async () => {})).rejects.toThrow('App AI is unavailable');
  release.resolve(); await pending; expect(lifecycle.signal.aborted).toBe(true);
});
it('rejects shutdown traffic before reading or validating its request body', async () => {
  const app = new Hono(); const runtime = registerAppAiCapabilities(app, { homePath, ownerIds: ['owner'], hermesRuntimeSource: {} as never });
  await runtime.close();
  expect((await app.request('/api/bridge/ai', { method: 'POST', body: 'not JSON' })).status).toBe(503);
  expect(mocks.generate).not.toHaveBeenCalled();
});
