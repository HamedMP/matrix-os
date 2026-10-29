import { afterEach, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { createCanonicalChatFixture } from '../contracts/fixtures/canonical-chat.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import { bootstrapBotDatabase, type OwnerBotDatabase } from '../../packages/gateway/src/bots/database.js';
import { createManagedPiOwnerTools } from '../../packages/gateway/src/chat/managed-pi-owner-tools.js';
import { createBotBrokerActions } from '../../packages/gateway/src/bots/broker-actions.js';
import { createBotToolDispatcher } from '../../packages/gateway/src/bots/tool-dispatcher.js';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createBotSessionsRepository } from '../../packages/gateway/src/bots/repositories/sessions.js';
import { createBotCheckpointsRepository } from '../../packages/gateway/src/bots/repositories/checkpoints.js';
import { createManagedPiSessionsRepository } from '../../packages/gateway/src/chat/managed-pi-sessions.js';
import { createManagedPiCheckpointsRepository } from '../../packages/gateway/src/chat/managed-pi-checkpoints.js';
import { getService } from '../../packages/gateway/src/integrations/registry.js';
import type { GoogleProcessingClaim } from '../../packages/gateway/src/google-data/runtime/envelope.js';
import { GOOGLE_PROCESSING_HEADER, verifyGoogleProcessingEnvelope } from '../../packages/gateway/src/google-data/runtime/envelope.js';
import { createBotIntegrationClient, createPlatformIntegrationTransport } from '../../packages/gateway/src/bots/integration-client.js';
import { createInternalIntegrationGuard } from '../../packages/platform/src/internal-integration-guard.js';
import { Hono } from 'hono';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it.each(['approve', 'cancel', 'paced-approve'] as const)('keeps Gmail human %s outside broker dispatch timeout and checkpoints', async scenario => {
  const paced = scenario === 'paced-approve'; const decision = scenario === 'cancel' ? 'cancel' : 'approve';
  const { db: fixture } = await createAuthorityFixture();
  const db = fixture.sql as Kysely<OwnerBotDatabase>;
  const repository = new ChatRepository(db as never); await repository.bootstrap(); await bootstrapBotDatabase(db);
  const owner = { type: 'personal' as const, ownerId: 'owner_consent_broker' };
  const { snapshot } = createCanonicalChatFixture('running');
  const chatId = snapshot.chat.id;
  await repository.create(owner, { id: chatId, clientRequestId: 'req_consent_broker', title: 'Synthetic consent test' });
  const { startedAt: _startedAt, ...prior } = snapshot.runs[0]!;
  const run = { ...prior, driverKind: 'matrix_pi' as const, instanceId: 'matrix_pi_default',
    selection: { instanceId: 'matrix_pi_default', model: 'synthetic-model' }, status: 'accepted' as const };
  await repository.admitTurn(owner, { chatId, baseRevision: 0, message: snapshot.messages[0]!,
    turn: { ...snapshot.turns[0]!, status: 'accepted' }, run });
  const registry = new BotRuntimeRegistry(); cleanups.push(async () => registry.shutdown());
  const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', ownerId: owner.ownerId, chatId, runId: run.id,
    runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'a'.repeat(64),
    route: { api: 'openai-completions', modelId: 'synthetic-model', input: ['text'], contextWindow: 128000, maxOutputTokens: 4096 },
    accessSourceId: 'matrix_included', capabilities: ['integration.call'], requestClass: 'interactive' };
  registry.bind(binding);
  const account = '123e4567-e89b-42d3-a456-426614174000';
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const claim: GoogleProcessingClaim = { ownerId: owner.ownerId, googleAccountId: account, runId: run.id,
    runtimeHandle: binding.runtimeHandle, executionGeneration: '1', profileId: randomUUID(), profileRevision: 1,
    consentId: randomUUID(), consentRevision: 1, purposeId: 'mail-assistance', routeDigest: 'a'.repeat(64), policyExpiresAt: expiry, collectionExpiresAt: expiry };
  let accepted = false; const events: any[] = []; const call = vi.fn(async () => ({ data: { messages: [] } }));
  const guard = createInternalIntegrationGuard(); const starts: number[] = [];
  const service = getService('gmail')!; const token = 'synthetic-machine-token';
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('internalContainerHandle' as never, 'fixture' as never); await next(); });
  app.use('*', guard.middleware);
  app.get('/', c => c.json([{ id: account, service: 'gmail', account_label: 'Synthetic Gmail', status: 'active' }]));
  app.get('/agent-catalog', c => c.json([{ id: 'gmail', name: service.name, actions: service.actions }]));
  app.post('/read-call', async c => {
    const body = await c.req.text();
    expect(verifyGoogleProcessingEnvelope(c.req.header(GOOGLE_PROCESSING_HEADER)!, {
      ownerId: owner.ownerId, machineToken: token, method: 'POST', path: '/read-call', body,
    })).toMatchObject(claim);
    expect(JSON.parse(body)).toMatchObject({ connectionId: account, action: 'get_thread_ids', params: { threadId: 'abc123' } });
    return c.json(await call());
  });
  const client = createBotIntegrationClient(createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid', machineToken: token,
    fetchImpl: (async (url, init) => { starts.push(performance.now()); return app.request(String(url), init); }) as typeof fetch }));
  const ownerTools = createManagedPiOwnerTools({ authority: async () => ({ permissionMode: 'full_access' }),
    signalFor: candidate => registry.inferenceSignal(candidate), integrations: paced ? client : { call,
      inventory: async () => [{ service: 'gmail', label: 'Synthetic Gmail', connectionId: account }],
      describe: async () => Object.entries(getService('gmail')!.actions).map(([id, a]) => ({ id, ...a })) },
    googleCollection: { prepare: async (_binding, _account, signal, consent) => {
      if (!accepted) accepted = await consent({ expiresAt: expiry, disclosure: { profileId: claim.profileId, profileRevision: 1,
        googleAccountId: account, purposeId: 'mail-assistance', evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1,
        purpose: 'Synthetic selected email test', recipients: [{ recipientId: 'synthetic', name: 'Synthetic provider', role: 'Test only' }],
        dataKinds: ['gmail-metadata', 'gmail-content', 'google-derived-context'], retention: { revision: 1, policyId: 'synthetic', mode: 'duration', maxAgeSeconds: 3600 }, expiresAt: expiry } }, signal);
      return structuredClone(claim);
    } } });
  await ownerTools.open(binding, event => events.push(event)); cleanups.push(() => ownerTools.closeRun(binding.runId));
  const lifetime = new AbortController();
  const checkpoints = createManagedPiCheckpointsRepository(db);
  const actions = createBotBrokerActions({ db, registry, toolTimeoutMs: paced ? 15000 : 30,
    sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
    managedSessions: createManagedPiSessionsRepository(db), managedCheckpoints: checkpoints,
    tools: createBotToolDispatcher({ homePath: '/synthetic', managedTools: ownerTools, managedWorkspace: async () => '/synthetic' }),
    runs: { loadRunSpec: async () => { throw Error('unused'); }, readImageChunk: async () => { throw Error('unused'); } },
    events: { publish: async () => {} }, inference: { homePath: '/synthetic', lifetime: lifetime.signal } });
  const pending = actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle: binding.runtimeHandle,
    executionGeneration: '1', runId: run.id, action: 'bot.tool', tool: { capability: 'integration.call', toolCallId: 'consent_read',
      args: { service: 'gmail', connectionId: account, action: 'get_thread_ids', params: { threadId: 'abc123' } } } });
  await vi.waitFor(() => expect(events.some(event => event.type === 'approval.requested')).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(call).not.toHaveBeenCalled();
  expect(await db.selectFrom('managed_pi_tool_checkpoints').selectAll().execute()).toEqual([]);
  if (decision === 'cancel') lifetime.abort();
  else await ownerTools.submit({ owner, chatId, runId: run.id, approvalId: events[0].approvalId, decision, clientRequestId: 'req_consent_approve' });
  const result = await pending;
  expect(result?.ok).toBe(decision === 'approve');
  expect(call).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0);
  const rows = await db.selectFrom('managed_pi_tool_checkpoints').select('phase').execute();
  expect(rows).toEqual(decision === 'approve' ? [{ phase: 'observed_complete' }] : []);
  expect(events.filter(event => event.type === 'approval.requested')).toHaveLength(1);
  if (paced) {
    expect(guard.snapshot().limited).toBe(0);
    expect(starts.length).toBeGreaterThanOrEqual(7);
    expect(starts.slice(1).every((at, i) => at - starts[i]! >= 500)).toBe(true);
  }
}, 20000);
