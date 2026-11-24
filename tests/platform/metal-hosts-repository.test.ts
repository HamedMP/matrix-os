import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import {
  createMetalHostsRepository,
  MetalHostInputSchema,
  MetalHostsRepositoryError,
  type MetalHostInput,
} from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

function host(overrides: Partial<MetalHostInput> = {}): MetalHostInput {
  return {
    id: 'metal-fsn-1',
    name: 'fsn-1',
    apiUrl: 'https://hostd.metal.example.test:9443',
    ingressHost: 'metal.example.test:9443',
    status: 'active',
    memoryCapacityMib: 131072,
    admissionCeilingMib: 114688,
    ...overrides,
  };
}

describe('metal hosts repository', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('listActive excludes draining and down hosts', async () => {
    const repo = createMetalHostsRepository(db.kysely);
    await repo.upsert(host({ id: 'h-active-b', name: 'b' }));
    await repo.upsert(host({ id: 'h-draining', name: 'draining', status: 'draining' }));
    await repo.upsert(host({ id: 'h-down', name: 'down', status: 'down' }));
    await repo.upsert(host({ id: 'h-active-a', name: 'a' }));

    const active = await repo.listActive();
    expect(active.map((h) => h.id)).toEqual(['h-active-a', 'h-active-b']);
    expect(active.every((h) => h.status === 'active')).toBe(true);
  });

  it('upsert inserts, then updates in place, and get reads the row back', async () => {
    const repo = createMetalHostsRepository(db.kysely);
    const created = await repo.upsert(host());
    expect(created).toMatchObject({
      id: 'metal-fsn-1',
      name: 'fsn-1',
      apiUrl: 'https://hostd.metal.example.test:9443',
      ingressHost: 'metal.example.test:9443',
      status: 'active',
      memoryCapacityMib: 131072,
      admissionCeilingMib: 114688,
    });
    expect(created.createdAt).toBeInstanceOf(Date);

    const updated = await repo.upsert(host({ status: 'draining', admissionCeilingMib: 98304 }));
    expect(updated).toMatchObject({ id: 'metal-fsn-1', status: 'draining', admissionCeilingMib: 98304 });
    expect(updated.createdAt.toISOString()).toBe(created.createdAt.toISOString());
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    expect(await repo.get('metal-fsn-1')).toEqual(updated);
    expect(await repo.get('missing')).toBeNull();
  });

  it('rejects a second host with the same name as a typed conflict', async () => {
    const repo = createMetalHostsRepository(db.kysely);
    await repo.upsert(host());
    await expect(repo.upsert(host({ id: 'metal-fsn-2' })))
      .rejects.toMatchObject({ name: 'MetalHostsRepositoryError', code: 'name_conflict' });
  });

  it('propagates database failures as a typed unavailable error, not as not-found', async () => {
    const repo = createMetalHostsRepository(db.kysely);
    await db.destroy();
    const failure = await repo.get('metal-fsn-1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MetalHostsRepositoryError);
    expect(failure).toMatchObject({ code: 'unavailable' });
    await expect(repo.listActive()).rejects.toMatchObject({ code: 'unavailable' });
    // Give afterEach a live database to tear down.
    ({ db } = await createTestPlatformDb());
  });

  it('rejects invalid input before it reaches the database', async () => {
    const repo = createMetalHostsRepository(db.kysely);
    await expect(repo.upsert(host({ admissionCeilingMib: 200000 })))
      .rejects.toMatchObject({ code: 'invalid_host' });
    await expect(repo.upsert(host({ id: 'Bad Id!' }))).rejects.toMatchObject({ code: 'invalid_host' });
    await expect(repo.get('../etc')).rejects.toMatchObject({ code: 'invalid_host' });
    expect(await repo.listActive()).toEqual([]);
  });
});

describe('metal host ingress and api URL validation', () => {
  const accept = (overrides: Partial<MetalHostInput>) =>
    expect(MetalHostInputSchema.safeParse(host(overrides)).success).toBe(true);
  const reject = (overrides: Partial<MetalHostInput>) =>
    expect(MetalHostInputSchema.safeParse(host(overrides)).success).toBe(false);

  it('accepts a hostname or IPv4 with an optional port as the ingress host', () => {
    accept({ ingressHost: 'metal.example.test' });
    accept({ ingressHost: 'metal.example.test:9443' });
    accept({ ingressHost: '51.158.248.135.nip.io:9443' });
    accept({ ingressHost: '203.0.113.10' });
    accept({ ingressHost: '203.0.113.10:1' });
    accept({ ingressHost: '203.0.113.10:65535' });
  });

  it('rejects ingress hosts with a scheme, path, credentials, bad port, or bad address', () => {
    reject({ ingressHost: 'https://metal.example.test' });
    reject({ ingressHost: 'metal.example.test/path' });
    reject({ ingressHost: 'user@metal.example.test' });
    reject({ ingressHost: 'metal.example.test:0' });
    reject({ ingressHost: 'metal.example.test:65536' });
    reject({ ingressHost: 'metal.example.test:09443' });
    reject({ ingressHost: 'metal.example.test:' });
    reject({ ingressHost: '256.1.1.1' });
    reject({ ingressHost: '-bad.example.test' });
    reject({ ingressHost: 'metal..example.test' });
    reject({ ingressHost: '[2001:db8::1]:9443' });
    reject({ ingressHost: 'metal.example.test?x=1' });
    reject({ ingressHost: ' metal.example.test' });
    reject({ ingressHost: '' });
    reject({ ingressHost: `${'a'.repeat(250)}.test` });
  });

  it('accepts only plain https api URLs', () => {
    accept({ apiUrl: 'https://hostd.example.test' });
    accept({ apiUrl: 'https://203.0.113.10:9443' });
    accept({ apiUrl: 'https://hostd.example.test:9443/' });
    reject({ apiUrl: 'http://hostd.example.test' });
    reject({ apiUrl: 'https://user:pass@hostd.example.test' });
    reject({ apiUrl: 'https://hostd.example.test?token=x' });
    reject({ apiUrl: 'https://hostd.example.test/#frag' });
    reject({ apiUrl: 'https://hostd.example.test/api' });
    reject({ apiUrl: 'ftp://hostd.example.test' });
    reject({ apiUrl: 'not a url' });
  });

  it('rejects an unknown status and non-positive capacities', () => {
    reject({ status: 'retired' as MetalHostInput['status'] });
    reject({ memoryCapacityMib: 0 });
    reject({ admissionCeilingMib: -1 });
    reject({ memoryCapacityMib: 1.5 });
  });
});
