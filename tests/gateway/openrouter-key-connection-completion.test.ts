import { describe, expect, it } from 'vitest';
import type { ProviderSettingsMutation, ProviderSettingsSnapshot } from '@matrix-os/contracts';
import { assertOpenRouterKeyConnectionSelection } from '../../packages/gateway/src/ai-providers/openrouter-key-connection-completion.js';

const generation = '11111111-1111-4111-8111-111111111111';
const mutation = { type: 'select_access_source', harnessInstanceId: 'harness_codex',
  accessSourceId: 'owner_openrouter', enableHarness: true, expectedRevision: 3,
  idempotencyKey: 'reuse-openrouter' } as ProviderSettingsMutation;
const snapshot = {
  access: { mode: 'writable' },
  harnesses: [{ id: 'harness_codex', harness: 'codex', installState: 'installed' }],
  accessSources: [{ id: 'owner_openrouter', providerId: 'openrouter', kind: 'provider_account',
    fundingKind: 'owner_api_key', accountId: 'owner_openrouter', credentialGeneration: generation,
    eligibleModelIds: ['openai/gpt-5.6-luna'], readiness: { state: 'ready' } }],
  accounts: [{ id: 'owner_openrouter', providerId: 'openrouter', accessSourceId: 'owner_openrouter',
    authMethod: 'api_key', authState: 'authenticated' }],
} as unknown as ProviderSettingsSnapshot;

describe('OpenRouter shared-key selection admission', () => {
  it('accepts the exact ready account, model, and credential generation', () => {
    expect(() => assertOpenRouterKeyConnectionSelection({ mutation, snapshot,
      modelId: 'openai/gpt-5.6-luna', credentialGeneration: generation })).not.toThrow();
  });

  it.each([
    { credentialGeneration: '22222222-2222-4222-8222-222222222222', modelId: 'openai/gpt-5.6-luna' },
    { credentialGeneration: generation, modelId: 'openai/unqualified' },
  ])('rejects stale generations and unqualified models', input => {
    expect(() => assertOpenRouterKeyConnectionSelection({ mutation, snapshot, ...input })).toThrow();
  });

  it('rejects reuse by a harness outside the qualified Claude and Codex paths', () => {
    const otherSnapshot = structuredClone(snapshot) as unknown as ProviderSettingsSnapshot;
    Object.assign(otherSnapshot.harnesses[0]!, { harness: 'pi' });
    expect(() => assertOpenRouterKeyConnectionSelection({ mutation, snapshot: otherSnapshot,
      modelId: 'openai/gpt-5.6-luna', credentialGeneration: generation })).toThrow();
  });
});
