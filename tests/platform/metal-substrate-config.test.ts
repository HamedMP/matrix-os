import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { loadMetalSubstrateConfig } from '../../packages/platform/src/substrates/metal-config.js';
import { createPlatformSubstrateRegistry } from '../../packages/platform/src/substrates/platform-substrates.js';
import { generateSelfSignedCert } from './fake-hostd-server.js';

const API_TOKEN = 'api-token-'.padEnd(40, 'x');
const INGRESS_TOKEN = 'ingress-token-'.padEnd(40, 'y');

const COMPLETE = {
  METAL_HOSTS_ENABLED: '1',
  METAL_HOSTD_API_TOKEN: API_TOKEN,
  METAL_HOSTD_INGRESS_TOKEN: INGRESS_TOKEN,
  METAL_GOLDEN_VERSION: 'golden-2026.11.20-1',
};

describe('metal substrate config', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is disabled unless METAL_HOSTS_ENABLED is set', () => {
    expect(loadMetalSubstrateConfig({ ...COMPLETE, METAL_HOSTS_ENABLED: undefined }))
      .toEqual({ enabled: false, reason: 'disabled' });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('is enabled with both tokens and a golden version', () => {
    expect(loadMetalSubstrateConfig(COMPLETE)).toEqual({
      enabled: true, apiToken: API_TOKEN, ingressToken: INGRESS_TOKEN, goldenVersion: 'golden-2026.11.20-1',
    });
  });

  it.each([
    ['the API token is missing', { METAL_HOSTD_API_TOKEN: undefined }],
    ['the ingress token is missing', { METAL_HOSTD_INGRESS_TOKEN: undefined }],
    ['the API token is shorter than 32 characters', { METAL_HOSTD_API_TOKEN: 'short' }],
    ['the CA PEM is not a certificate', { METAL_HOSTD_CA_PEM: 'not a pem' }],
    ['the golden version is missing', { METAL_GOLDEN_VERSION: undefined }],
    ['the golden version has unsafe characters', { METAL_GOLDEN_VERSION: 'golden/../x' }],
    ['the golden version is longer than 64 characters', { METAL_GOLDEN_VERSION: 'g'.repeat(65) }],
  ])('fails closed when %s, without logging token values', (_name, overrides) => {
    expect(loadMetalSubstrateConfig({ ...COMPLETE, ...overrides })).toEqual({ enabled: false, reason: 'incomplete' });
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain(API_TOKEN);
    expect(logged).not.toContain(INGRESS_TOKEN);
  });

  it('accepts a CA PEM, including one with escaped newlines', () => {
    const { cert } = generateSelfSignedCert();
    const escaped = cert.trim().replace(/\n/g, '\\n');

    const config = loadMetalSubstrateConfig({ ...COMPLETE, METAL_HOSTD_CA_PEM: escaped });

    expect(config).toMatchObject({ enabled: true });
    expect(config.enabled && config.caPem?.trim()).toBe(cert.trim());
  });
});

describe('platform substrate registration', () => {
  // Registration reads no rows up front except the best-effort host cache
  // warm-up, which fails here and is only logged.
  const db = {
    kysely: { selectFrom: () => { throw new Error('no database in this test'); } },
  } as unknown as PlatformDB;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('metal is not registered when its tokens are missing', () => {
    const registry = createPlatformSubstrateRegistry(db, { METAL_HOSTS_ENABLED: '1' });

    expect(registry.get('metal')).toEqual({ ok: false, reason: 'substrate_unavailable' });
    expect(registry.get('vps').ok).toBe(true);
  });

  it('metal is not registered when it is not enabled', () => {
    const registry = createPlatformSubstrateRegistry(db, { ...COMPLETE, METAL_HOSTS_ENABLED: '0' });
    expect(registry.get('metal').ok).toBe(false);
  });

  it('metal is registered when enabled with both tokens', () => {
    const registry = createPlatformSubstrateRegistry(db, COMPLETE);

    const lookup = registry.get('metal');
    expect(lookup.ok && lookup.substrate.kind).toBe('metal');
  });

  it('the metal resume hook reaches the caller (managed-feature resume trigger)', () => {
    const resumed: string[] = [];
    const registry = createPlatformSubstrateRegistry(db, COMPLETE, { onMetalResumed: (ref) => { resumed.push(ref.handle); } });
    const lookup = registry.get('metal');
    if (!lookup.ok) throw new Error('metal substrate missing');
    lookup.substrate.onResumed?.({ machineId: 'm-1', handle: 'alice', runtimeSlot: 'primary', generation: 1 });
    expect(resumed).toEqual(['alice']);
    const vps = registry.get('vps');
    expect(vps.ok && vps.substrate.onResumed).toBeUndefined();
  });
});
