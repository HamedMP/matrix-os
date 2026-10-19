import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixFundedCredentialProvider } from '../../packages/gateway/src/funded-ai-credential-manager.js';
import { prepareWorkspaceGatewayCredentials } from '../../packages/workspace-worker/runtime/gateway-credentials.js';

const now = 1_800_000_000_000;
const token = `sk-matrix-funded-credential_123.${'A'.repeat(43)}`;
let homePath: string;
const environment = () => ({
  RUNTIME_INFERENCE_MODE: 'matrix-gateway', MATRIX_WORKSPACE_OWNER_ID: 'owner_a', MATRIX_WORKSPACE_GENERATION: '2',
  MATRIX_FUNDED_AI_ENABLED: '1', MATRIX_HANDLE: 'swp-2758-aabbccdd', MATRIX_CLERK_USER_ID: 'owner_a', MATRIX_USER_ID: 'owner_a',
  MATRIX_MACHINE_ID: 'machine_a', MATRIX_RUNTIME_SLOT: 'swp-2758-aabbccdd', MATRIX_FUNDED_AI_RUNTIME_TOKEN: 'R'.repeat(64),
  MATRIX_FUNDED_AI_PLATFORM_URL: 'https://platform.example.com', MATRIX_FUNDED_AI_RELAY_URL: 'https://relay.example.com',
  MATRIX_FUNDED_AI_RUN_TIMEOUT_MS: '300000', HOME: '/workspace/home', PATH: '/usr/local/bin:/usr/bin',
  DATABASE_URL: 'postgres://owner:secret@db.example.com/kernel', ANTHROPIC_API_KEY: 'unrelated-owner-key',
  ANTHROPIC_AUTH_TOKEN: 'unrelated-owner-token', ANTHROPIC_CUSTOM_HEADERS: 'unrelated-header',
});
const lease = () => ({ token, tokenId: 'credential_123', expiresAt: new Date(now + 900_000).toISOString(),
  relayBaseUrl: 'https://relay.example.com', maxRunMs: 300_000, requestClass: 'background' as const });
function provider(value = lease()): MatrixFundedCredentialProvider {
  return { enabled: true, maxRunMs: 300_000, getCredential: vi.fn(async () => value), invalidate: vi.fn(), close: vi.fn() };
}
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), 'matrix-credentials-')); });
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('isolated SDK Matrix gateway compatibility authority', () => {
  it('issues background access without saving a Matrix lease as an owner API key', async () => {
    const authority = provider();
    const prepared = await prepareWorkspaceGatewayCredentials(homePath, environment(), { createProvider: () => authority, now: () => now });
    const signal = new AbortController().signal;
    const launch = await prepared.kernelCredentialResolver!({ model: 'claude-sonnet-5', requestClass: 'interactive', signal });
    expect(prepared.model).toBe('claude-sonnet-5');
    expect(authority.getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: 'background', signal }));
    expect(launch.env).toMatchObject({ ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: 'https://relay.example.com' });
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'MATRIX_FUNDED_AI_RUNTIME_TOKEN', 'DATABASE_URL']) expect(launch.env?.[key]).toBeUndefined();
    expect(launch.env?.HOME).toBe('/workspace/home');
    expect(await readdir(homePath)).toEqual([]);
    await prepared.close();
    expect(authority.close).toHaveBeenCalledOnce();
    await expect(prepared.kernelCredentialResolver!({ model: 'claude-sonnet-5', requestClass: 'background' })).rejects.toThrow(/^Matrix AI unavailable$/);
  });

  it.each([
    { MATRIX_WORKSPACE_OWNER_ID: 'owner_b' }, { MATRIX_USER_ID: 'owner_b' }, { MATRIX_HANDLE: 'personal-vps' },
    { MATRIX_RUNTIME_SLOT: 'primary' }, { MATRIX_WORKSPACE_GENERATION: '0' }, { MATRIX_FUNDED_AI_RELAY_URL: 'https://user:secret@relay.example.com' },
  ])('rejects mismatched or personal-runtime configuration before obtaining a credential: %j', async change => {
    const createProvider = vi.fn(() => provider());
    await expect(prepareWorkspaceGatewayCredentials(homePath, { ...environment(), ...change }, { createProvider, now: () => now })).rejects.toThrow(/^Matrix AI unavailable$/);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each([
    { expiresAt: new Date(now + 1000).toISOString() }, { relayBaseUrl: 'https://other.example.com' },
    { requestClass: 'interactive' }, { token: 'private-malformed-token' },
  ])('denies unusable leases without exposing their contents: %j', async change => {
    const authority = provider({ ...lease(), ...change } as ReturnType<typeof lease>);
    const prepared = await prepareWorkspaceGatewayCredentials(homePath, environment(), { createProvider: () => authority, now: () => now });
    await expect(prepared.kernelCredentialResolver!({ model: 'claude-sonnet-5', requestClass: 'background' })).rejects.toThrow(/^Matrix AI unavailable$/);
    await prepared.close();
  });

  it('rejects model/source changes and cancellation without acquiring a lease', async () => {
    const authority = provider();
    const prepared = await prepareWorkspaceGatewayCredentials(homePath, environment(), { createProvider: () => authority, now: () => now });
    for (const input of [{ model: 'claude-haiku-4-5' }, { model: 'claude-sonnet-5', accessSourceId: 'owner_anthropic_key' as const },
      { model: 'claude-sonnet-5', signal: AbortSignal.abort() }]) {
      await expect(prepared.kernelCredentialResolver!({ ...input, requestClass: 'background' })).rejects.toThrow(/^Matrix AI unavailable$/);
    }
    expect(authority.getCredential).not.toHaveBeenCalled();
    await prepared.close();
  });
});
