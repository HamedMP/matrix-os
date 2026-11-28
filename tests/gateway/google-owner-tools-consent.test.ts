import { describe, expect, it, vi } from 'vitest';
import { BotToolRequestSchema } from '@matrix-os/contracts';
import { createManagedPiOwnerTools } from '../../packages/gateway/src/chat/managed-pi-owner-tools.js';
import type { ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { getService } from '../../packages/gateway/src/integrations/registry.js';
import type { GoogleCollectionClientDependencies } from '../../packages/gateway/src/google-data/runtime/collection-client.js';
import type { GoogleProcessingClaim } from '../../packages/gateway/src/google-data/runtime/envelope.js';
const account = '123e4567-e89b-42d3-a456-426614174000';
const binding = { kind: 'managed_chat', ownerId: 'user_owner', chatId: 'chat_one', runId: 'run_one', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', capabilities: ['integration.call'], workspace: { kind: 'chat_workspace' }, rootFingerprint: 'a'.repeat(64) } as ManagedPiRuntimeBinding;
const notice: Parameters<GoogleCollectionClientDependencies['requestConsent']>[0] = { expiresAt: new Date(Date.now() + 60000).toISOString(), disclosure: {
  profileId: '223e4567-e89b-42d3-a456-426614174000', profileRevision: 1, googleAccountId: account, evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1,
  purposeId: 'mail-assistance', purpose: 'Help with your email', recipients: [{ recipientId: 'cf', name: 'Cloudflare', role: 'AI processing' }, { recipientId: 'model', name: 'Model provider', role: 'Inference' }],
  dataKinds: ['gmail-metadata', 'gmail-content', 'gmail-attachments', 'google-derived-context'], retention: { revision: 1, policyId: 'retention', mode: 'duration', maxAgeSeconds: 86400 }, expiresAt: new Date(Date.now() + 120000).toISOString() } };
const claim = { ownerId: binding.ownerId, googleAccountId: account, runId: binding.runId, runtimeHandle: binding.runtimeHandle, executionGeneration: '1', profileId: notice.disclosure.profileId, profileRevision: 1,
  consentId: '323e4567-e89b-42d3-a456-426614174000', consentRevision: 1, purposeId: 'mail-assistance', routeDigest: 'a'.repeat(64), policyExpiresAt: notice.expiresAt, collectionExpiresAt: notice.expiresAt } satisfies GoogleProcessingClaim;
function fixture(options: { missing?: boolean; prompt?: boolean; write?: boolean } = {}) {
  const controller = new AbortController(); const events: any[] = [];
  const call = vi.fn(async () => ({ data: { ok: true } }));
  let consentActive = options.prompt === false;
  let currentClaim = structuredClone(claim);
  const prepare = vi.fn(async (_binding: ManagedPiRuntimeBinding, _account: string, signal: AbortSignal, requestConsent: GoogleCollectionClientDependencies['requestConsent']) => {
    if (!consentActive) {
      if (await requestConsent(structuredClone(notice), signal) !== true) throw new Error('not accepted');
      consentActive = true;
    }
    return structuredClone(currentClaim);
  });
  let permissionMode = 'full_access';
  const tools = createManagedPiOwnerTools({ authority: async () => ({ permissionMode }), signalFor: () => controller.signal,
    integrations: { call, inventory: async () => [{ connectionId: account, label: 'Work', service: 'gmail' }],
      describe: async () => Object.entries(getService('gmail')!.actions).map(([id, action]) => ({ id, description: action.description, risk: action.risk, params: action.params })) },
    ...(!options.missing ? { googleCollection: { prepare } } : {}) });
  const open = tools.open(binding, event => events.push(event));
  const request = BotToolRequestSchema.parse({ capability: 'integration.call', toolCallId: 'call_one', args: { service: 'gmail', connectionId: account, action: options.write ? 'send_email' : 'get_message', params: options.write ? { to: 'recipient@example.invalid', subject: 'Synthetic', body: 'Synthetic' } : { messageId: 'message1' } } });
  const run = async () => { await open; return tools.dispatch(binding, request, controller.signal); };
  const submit = (decision: 'approve' | 'decline' | 'cancel', ownerId = binding.ownerId) => tools.submit({ owner: { type: 'personal', ownerId }, chatId: binding.chatId, runId: binding.runId,
    approvalId: events.filter(e => e.type === 'approval.requested').at(-1).approvalId, decision, clientRequestId: 'client_one' });
  return { tools, controller, events, call, prepare, run, submit, request, replaceClaim: (patch: Partial<GoogleProcessingClaim>) => { currentClaim = { ...currentClaim, ...patch }; }, revoke: () => { consentActive = false; }, supervise: () => { permissionMode = 'supervised'; } };
}
describe('owner Gmail processing consent', () => {
  it('requires a separate owner decision even in a full-access read and privately passes the exact claim/account', async () => {
    const f = fixture(); const work = f.run();
    await vi.waitFor(() => expect(f.events[0]?.type).toBe('approval.requested'));
    expect(f.call).not.toHaveBeenCalled(); const event = f.events[0];
    expect(event.title).toBe('Allow this AI to use Gmail data?');
    expect(event.safeDescription).toMatch(/Cloudflare/); expect(event.safeDescription).toMatch(/Model provider/);
    expect(event.safeDescription).toMatch(/Help with your email/); expect(event.safeDescription).toMatch(/attachment/i); expect(event.safeDescription).toMatch(/1 day/);
    expect(JSON.stringify(event)).not.toMatch(/routeDigest|fingerprint|runtimeHandle|223e4567|323e4567/);
    expect(event.allowedDecisions).toEqual(['approve', 'decline', 'cancel']);
    await expect(f.submit('approve', 'other')).rejects.toThrow(); expect(f.call).not.toHaveBeenCalled();
    await f.submit('approve'); const result = await work;
    expect(f.call).toHaveBeenCalledWith(binding.ownerId, expect.objectContaining({ connectionId: account, processingClaim: claim }), expect.any(AbortSignal));
    expect(f.prepare).toHaveBeenCalledWith(binding, account, expect.any(AbortSignal), expect.any(Function), 'get_message');
    expect(JSON.stringify(result)).not.toMatch(/routeDigest|consentId|profileId|runtimeHandle/);
    await f.tools.closeRun(binding.runId);
  });
  it('rechecks write permission after processing consent instead of retaining full access', async () => {
    const f = fixture({ write: true }); const work = f.run(); const rejected = expect(work).rejects.toThrow();
    await vi.waitFor(() => expect(f.events.filter(e => e.type === 'approval.requested')).toHaveLength(1));
    await f.submit('approve');
    await vi.waitFor(() => expect(f.events.filter(e => e.type === 'approval.requested')).toHaveLength(2));
    f.supervise(); await f.submit('approve'); await rejected;
    expect(f.call).not.toHaveBeenCalled(); await f.tools.closeRun(binding.runId);
  });
  it.each(['decline', 'cancel'] as const)('refuses %s without dispatching Gmail', async decision => {
    const f = fixture(); const work = f.run(); const rejected = expect(work).rejects.toThrow();
    await vi.waitFor(() => expect(f.events[0]?.type).toBe('approval.requested')); await f.submit(decision); await rejected;
    expect(f.call).not.toHaveBeenCalled(); await f.tools.closeRun(binding.runId);
  });
  it('cancels a pending processing notice with the live run', async () => {
    const f = fixture(); const work = f.run(); const rejected = expect(work).rejects.toThrow();
    await vi.waitFor(() => expect(f.events[0]?.type).toBe('approval.requested')); f.controller.abort(); await rejected;
    expect(f.call).not.toHaveBeenCalled(); expect(f.events.at(-1)).toMatchObject({ type: 'approval.resolved', decision: 'cancel' }); await f.tools.closeRun(binding.runId);
  });
  it('denies Gmail when its processing authority is not installed', async () => {
    const f = fixture({ missing: true }); await expect(f.run()).rejects.toThrow(); expect(f.call).not.toHaveBeenCalled(); await f.tools.closeRun(binding.runId);
  });
  it('uses an already-current consent without an invented extra prompt', async () => {
    const f = fixture({ prompt: false }); await f.run(); expect(f.events).toEqual([]); expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.call).toHaveBeenCalledOnce(); await f.tools.closeRun(binding.runId);
  });
});


describe('Gmail consent preflight deadline', () => {
  it('waits for the person before the short external dispatch deadline starts', async () => {
    const f = fixture();
    const prepared = f.tools.prepare(binding, f.request, f.controller.signal);
    await vi.waitFor(() => expect(f.events[0]?.type).toBe('approval.requested'), { timeout: 250 });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(f.call).not.toHaveBeenCalled();
    await f.submit('approve'); await prepared;
    const result = await f.tools.dispatch(binding, f.request, AbortSignal.timeout(30));
    expect(result.ok).toBe(true);
    expect(f.events.filter(e => e.type === 'approval.requested')).toHaveLength(1);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.call).toHaveBeenCalledOnce();
    await f.tools.closeRun(binding.runId);
  });
  it('refuses consent invalidated after preflight without opening another dispatch-time prompt', async () => {
    const f = fixture();
    const prepared = f.tools.prepare(binding, f.request, f.controller.signal);
    await vi.waitFor(() => expect(f.events[0]?.type).toBe('approval.requested'), { timeout: 250 });
    await f.submit('approve'); await prepared; f.revoke();
    await expect(f.tools.dispatch(binding, f.request, AbortSignal.timeout(30))).rejects.toThrow();
    expect(f.events.filter(e => e.type === 'approval.requested')).toHaveLength(1);
    expect(f.call).not.toHaveBeenCalled();
    await f.tools.closeRun(binding.runId);
  });
});


it.each([
  { consentId: '423e4567-e89b-42d3-a456-426614174000' }, { consentRevision: 2 },
  { profileId: '523e4567-e89b-42d3-a456-426614174000' }, { profileRevision: 2 },
  { routeDigest: 'b'.repeat(64) }, { executionGeneration: '2' },
  { policyExpiresAt: new Date(Date.now() + 180000).toISOString() },
])('rejects replacement authorized processing authority after preflight: %j', async patch => {
  const f = fixture({ prompt: false });
  await f.tools.prepare(binding, f.request, f.controller.signal); f.replaceClaim(patch);
  await expect(f.tools.dispatch(binding, f.request, f.controller.signal)).rejects.toThrow();
  expect(f.call).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  await f.tools.closeRun(binding.runId);
});

it.each([-1000, 1000])('never expands the preflight collection expiry (%i)', async change => {
  const f = fixture({ prompt: false });
  await f.tools.prepare(binding, f.request, f.controller.signal);
  const next = new Date(Date.parse(claim.collectionExpiresAt) + change).toISOString();
  f.replaceClaim({ collectionExpiresAt: next });
  await f.tools.dispatch(binding, f.request, f.controller.signal);
  expect(f.call).toHaveBeenCalledWith(binding.ownerId,
    expect.objectContaining({ processingClaim: expect.objectContaining({ collectionExpiresAt: change < 0 ? next : claim.collectionExpiresAt }) }),
    expect.any(AbortSignal));
  await f.tools.closeRun(binding.runId);
});
