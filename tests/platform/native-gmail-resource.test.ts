import { describe, expect, it, vi } from 'vitest';
import { initializeOwnedIntegrationDb } from '../../packages/platform/src/native-gmail-startup.js';
describe('owned integration database lifetime', () => {
  it('registers cleanup before migration and closes exactly once after startup failure', async () => {
    let close!: () => Promise<void>;
    const destroy = vi.fn(async () => undefined);
    const migrate = vi.fn(async () => { expect(close).toBeTypeOf('function'); throw new Error('migration failed'); });
    await expect(initializeOwnedIntegrationDb({ create: () => ({ migrate, destroy }), registerClose: fn => { close = fn; } })).rejects.toThrow('migration failed');
    await close(); expect(destroy).toHaveBeenCalledOnce();
  });
  it('keeps a successfully initialized pool open until shutdown and shares one close promise', async () => {
    let close!: () => Promise<void>; const destroy = vi.fn(async () => undefined);
    const resource = { migrate: vi.fn(async () => undefined), destroy };
    expect(await initializeOwnedIntegrationDb({ create: () => resource, registerClose: fn => { close = fn; } })).toBe(resource);
    expect(destroy).not.toHaveBeenCalled(); await Promise.all([close(), close()]); expect(destroy).toHaveBeenCalledOnce();
  });
});
