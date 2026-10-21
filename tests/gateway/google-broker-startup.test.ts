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
