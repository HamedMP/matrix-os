import { afterEach, describe, expect, it } from 'vitest';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createGoogleBrokerRuntime } from '../../packages/gateway/src/startup/google-data.js';

let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'] | undefined;
let runtime: Awaited<ReturnType<typeof createGoogleBrokerRuntime>> | undefined;
const registry = new BotRuntimeRegistry();
afterEach(async () => { registry.shutdown(); await runtime?.close(); runtime = undefined; await db?.destroy(); db = undefined; });
const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner-one',
  chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64),
  route: { api: 'anthropic-messages', modelId: 'model-a', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'owner_anthropic_key', anthropicApi: { connectionRevision: 1, credentialGeneration: '523e4567-e89b-42d3-a456-426614174000' },
  capabilities: ['artifact.read'], requestClass: 'interactive' };
describe('Google policy broker composition', () => {
  it('keeps an observed route private and binds it to the live execution generation', async () => {
    ({ db } = await createAuthorityFixture()); registry.bind(binding);
    runtime = await createGoogleBrokerRuntime({ database: db.sql, registry });
    const identity = { endpoint: 'https://api.example.invalid/v1/messages?beta=true', api: 'anthropic-messages' as const,
      modelId: binding.route.modelId, harnessVersion: 'test-harness', credential: { kind: 'api_key' as const,
        fingerprint: 'a'.repeat(64), generation: binding.anthropicApi!.credentialGeneration } };
    expect(runtime.observedIdentity(binding)).toBeNull();
    expect(await runtime.inference.authorize({ phase: 'dispatch', binding, identity, signal: new AbortController().signal })).toEqual({ allowed: true, googleOrigin: false });
    const observed = runtime.observedIdentity(binding);
    expect(observed).toEqual(identity);
    identity.endpoint = 'https://changed.example.invalid/v1/messages';
    expect(runtime.observedIdentity(binding)?.endpoint).toBe('https://api.example.invalid/v1/messages?beta=true');
    expect(runtime.observedIdentity({ ...binding, executionGeneration: '2' })).toBeNull();
    registry.cancelInference(binding);
    expect(runtime.observedIdentity(binding)).toBeNull();
  });
  it('installs durable classification and refuses Google transfers when transport is unavailable', async () => {
    ({ db } = await createAuthorityFixture()); registry.bind(binding);
    runtime = await createGoogleBrokerRuntime({ database: db.sql, registry });
    runtime.start();
    const request = { phase: 'dispatch' as const, binding, identity: null, signal: new AbortController().signal };
    expect(await runtime.inference.authorize(request)).toEqual({ allowed: true, googleOrigin: false });
    const deadline = new Date(Date.now() + 60000).toISOString();
    await runtime.contexts.mark({ ownerId: binding.ownerId, chatId: binding.chatId,
      googleAccountId: '123e4567-e89b-42d3-a456-426614174000', consentId: 'source_one', profileId: 'source_one',
      profileRevision: 1, purposeId: 'mail-assistance', expiresAt: deadline, retentionDeadline: deadline });
    expect(await runtime.inference.authorize(request)).toEqual({ allowed: false });
    await runtime.close();
    // Closing processing resources never destroys the owner's injected database.
    expect((await db.repository.listReviewedProfiles(binding.ownerId))).toEqual([]);
  });
});
