import { describe, expect, it, vi } from 'vitest';
import { assertLocalDevstackDatabase, parseDevstackBootstrapInput } from '../../packages/platform/src/devstack-bootstrap.js';
import { runDevstackBootstrap } from '../../scripts/devstack-bootstrap.js';

const localUrl = 'postgresql://local:private@127.0.0.1:55432/matrixos_devstack_demo_a';

describe('DevStack bootstrap database boundary', () => {
  it('accepts only the explicitly selected local instance database', () => {
    expect(assertLocalDevstackDatabase(localUrl, 'demo-a', 'local')).toBe(localUrl);
    expect(assertLocalDevstackDatabase(localUrl.replace('127.0.0.1', '[::1]'), 'demo-a', 'local'))
      .toContain('[::1]');
  });

  it.each([
    ['production mode', localUrl, 'demo-a', 'cloud_run'],
    ['unspecified mode', localUrl, 'demo-a', undefined],
    ['remote database', localUrl.replace('127.0.0.1', 'db.example.com'), 'demo-a', 'local'],
    ['DNS alias', localUrl.replace('127.0.0.1', 'localhost'), 'demo-a', 'local'],
    ['all-interface host', localUrl.replace('127.0.0.1', '0.0.0.0'), 'demo-a', 'local'],
    ['production database name', localUrl.replace('matrixos_devstack_demo_a', 'matrixos_platform'), 'demo-a', 'local'],
    ['another instance database', localUrl.replace('demo_a', 'demo_b'), 'demo-a', 'local'],
    ['URL options', `${localUrl}?options=-csearch_path%3Dpublic`, 'demo-a', 'local'],
    ['service options', `${localUrl}?service=production`, 'demo-a', 'local'],
    ['fragment', `${localUrl}#production`, 'demo-a', 'local'],
    ['wrong protocol', localUrl.replace('postgresql:', 'https:'), 'demo-a', 'local'],
    ['ambiguous instance', localUrl, 'demo_a', 'local'],
    ['invalid URL', 'private', 'demo-a', 'local'],
  ])('rejects %s without exposing connection credentials', (_case, url, instance, mode) => {
    let thrown: unknown;
    try { assertLocalDevstackDatabase(url!, instance!, mode); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain('private');
    expect((thrown as Error).message).not.toContain(url!);
  });

  it('rejects an unsafe CLI destination before opening or migrating any database', async () => {
    const openDatabase = vi.fn(() => { throw new Error('Database must not be opened'); });
    await expect(runDevstackBootstrap({ args: ['--instance', 'demo-a'],
      env: { PLATFORM_RUNTIME_MODE: 'local', PLATFORM_DATABASE_URL: localUrl.replace('127.0.0.1', 'db.example.com') },
      openDatabase })).rejects.toThrow(/local|loopback/i);
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('rejects names and shortened Docker IDs before registration', () => {
    for (const containerId of ['matrixos-owned', 'ab1234567890']) {
      expect(() => parseDevstackBootstrapInput({ instance: 'demo-a', clerkUserId: 'user_example', handle: 'example',
        email: 'example@example.com', gatewayPort: 4000, shellPort: 3000, containerId })).toThrow(/registration/i);
    }
  });

  it('prints help without acquiring a database', async () => {
    const openDatabase = vi.fn(() => { throw new Error('Database must not be opened'); });
    expect(await runDevstackBootstrap({ args: ['--help'], env: {}, openDatabase })).toHaveProperty('usage');
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('rejects incomplete identity before migration can run', async () => {
    const openDatabase = vi.fn(() => { throw new Error('Database must not be opened'); });
    await expect(runDevstackBootstrap({ args: ['--instance', 'demo-a'],
      env: { PLATFORM_RUNTIME_MODE: 'local', PLATFORM_DATABASE_URL: localUrl }, openDatabase }))
      .rejects.toThrow(/identity|registration/i);
    expect(openDatabase).not.toHaveBeenCalled();
  });
});
