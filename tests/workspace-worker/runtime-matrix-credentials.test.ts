import { describe, expect, it } from 'vitest';
import { createPreviewCredentialResolver, resolveRuntimeCredentials } from '../../packages/workspace-worker/src/runtime/credentials.js';
const now = 1_800_000_000_000;
const scope = { ownerId: 'owner_a', generation: 2 };
const matrixGateway = () => ({ ownerId: 'owner_a', machineId: 'machine_a', handle: 'swp-2758-aabbccdd', runtimeSlot: 'swp-2758-aabbccdd',
  platformOrigin: 'https://platform.example.com', relayOrigin: 'https://relay.example.com', runtimeToken: 'R'.repeat(64), maxRunMs: 300_000 });
const credentials = () => ({ ...scope, databaseUrl: 'postgres://owner:secret@db.example.com/kernel', authToken: 'owner-a-generation-auth', expiresAt: now + 900_000,
  matrixGateway: matrixGateway() });

describe('owner-scoped Matrix gateway runtime credentials', () => {
  it('accepts a single exact Matrix authority instead of a personal inference key', async () => {
    const result = await resolveRuntimeCredentials(async () => credentials(), scope, () => now);
    expect(result.matrixGateway).toEqual(matrixGateway());
    expect(result.inferenceKey).toBeUndefined();
  });
  it.each([
    { ownerId: 'owner_b' }, { runtimeSlot: 'primary' }, { handle: 'personal-vps' }, { runtimeToken: 'short' },
    { platformOrigin: 'http://localhost' }, { relayOrigin: 'https://user:secret@relay.example.com' }, { maxRunMs: 0 },
  ])('denies invalid or mismatched Matrix authority: %j', async change => {
    await expect(resolveRuntimeCredentials(async () => ({ ...credentials(), matrixGateway: { ...matrixGateway(), ...change } }), scope, () => now)).rejects.toThrow(/^Runtime credentials unavailable$/);
  });
  it('rejects ambiguous authorities and leaves the old inference path fail-closed', async () => {
    await expect(resolveRuntimeCredentials(async () => ({ ...credentials(), inferenceKey: 'personal-key' }), scope, () => now)).rejects.toThrow();
    await expect(resolveRuntimeCredentials(async () => ({ ...credentials(), matrixGateway: undefined }), scope, () => now)).rejects.toThrow();
  });
  it('creates a generation-bound explicit preview Matrix authority without an Anthropic key', async () => {
    const env = { PREVIEW_ENABLED: '1', PREVIEW_OWNER_ID: 'owner_a', RUNTIME_INFERENCE_MODE: 'matrix-gateway',
      RUNTIME_AUTH_SECRET: 'generation-auth-secret', RUNTIME_DATABASE_URL: credentials().databaseUrl,
      MATRIX_MACHINE_ID: 'machine_a', MATRIX_HANDLE: 'swp-2758-aabbccdd', MATRIX_RUNTIME_SLOT: 'swp-2758-aabbccdd',
      MATRIX_FUNDED_AI_PLATFORM_URL: 'https://platform.example.com', MATRIX_FUNDED_AI_RELAY_URL: 'https://relay.example.com',
      MATRIX_FUNDED_AI_RUNTIME_TOKEN: 'R'.repeat(64), RUNTIME_MAX_RUN_MS: '300000', ANTHROPIC_API_KEY: 'must-not-fall-back' };
    const resolver = createPreviewCredentialResolver(env, () => now);
    const first = await resolveRuntimeCredentials(resolver, scope, () => now);
    const next = await resolveRuntimeCredentials(resolver, { ...scope, generation: 3 }, () => now);
    expect(first.matrixGateway).toEqual(matrixGateway());
    expect(first.inferenceKey).toBeUndefined();
    expect(first.authToken).not.toBe(next.authToken);
    await expect(resolveRuntimeCredentials(resolver, { ownerId: 'owner_b', generation: 2 }, () => now)).rejects.toThrow();
    await expect(resolveRuntimeCredentials(createPreviewCredentialResolver({ ...env, MATRIX_FUNDED_AI_RUNTIME_TOKEN: '' }, () => now), scope, () => now)).rejects.toThrow();
  });
});
