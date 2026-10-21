import { describe, expect, it, vi } from 'vitest';
import { createPlatformGoogleCollectionAdmission, type InternalGoogleCollectionAdmission } from '../../packages/platform/src/google-collection-admission.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';

describe('platform-owned Google collection token adapter', () => {
  it('derives the expected machine key solely from the factory-provided authenticated handle', () => {
    const integrationDb = { synthetic: true }; let derive!: (handle: string) => string;
    const lease = { beforeSend: async () => undefined, release: async () => undefined };
    const admission: InternalGoogleCollectionAdmission = { admit: async () => lease };
    const createAdmission = vi.fn(options => { expect(options.db).toBe(integrationDb); derive = options.machineTokenForHandle; return admission; });
    expect(createPlatformGoogleCollectionAdmission({ integrationDb, platformSecret: 'synthetic-private-platform-secret', createAdmission })).toBe(admission);
    expect(derive('alice')).toBe(buildPlatformVerificationToken('alice', 'synthetic-private-platform-secret'));
    expect(derive('alice')).not.toBe(derive('bob'));
    expect(() => derive('../alice')).toThrow('Internal Gmail admission unavailable');
  });
  it('fails closed without a platform secret before constructing admission', () => {
    const createAdmission = vi.fn();
    expect(() => createPlatformGoogleCollectionAdmission({ integrationDb: {}, platformSecret: '', createAdmission })).toThrow('Internal Gmail admission unavailable');
    expect(createAdmission).not.toHaveBeenCalled();
  });
});
