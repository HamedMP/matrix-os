import { describe, expect, it } from 'vitest';
import { MatrixComputerListSchema } from '@matrix-os/contracts';
import { WebComputerListSchema, starterPilotForOwner } from '../../packages/contracts/src/starter-computers.js';
const starter = { handle: 'hamed', runtimeSlot: 'starter', label: 'Starter Computer', availability: 'available', kind: 'starter', gatewayPath: '/workspace', capabilities: ['starterComputerWebV1'] };
describe('opt-in Starter computer contract', () => {
  it('accepts the Web entry without expanding the native computer contract', () => {
    const payload = { items: [starter], selectedSlot: 'starter', hasMore: false, limit: 20 };
    expect(WebComputerListSchema.safeParse(payload).success).toBe(true);
    expect(MatrixComputerListSchema.safeParse(payload).success).toBe(false);
  });
  it.each([{ gatewayPath: 'https://evil.test' }, { runtimeSlot: 'primary' }, { token: 'private-secret' }, { ownerId: 'user_hamed' }])('rejects unsafe or private inventory fields', (patch) => {
    expect(WebComputerListSchema.safeParse({ items: [{ ...starter, ...patch }], selectedSlot: null, hasMore: false, limit: 20 }).success).toBe(false);
  });
  it('bounds private configuration and never authorizes a different owner', () => {
    const entry = { ownerId: 'user_hamed', handle: 'hamed', origin: 'https://hamed.workers.dev', token: 'h'.repeat(48) };
    expect(starterPilotForOwner(JSON.stringify([entry]), 'user_hamed')).toEqual(entry);
    expect(starterPilotForOwner(JSON.stringify([entry]), 'user_nima')).toBeUndefined();
    expect(() => starterPilotForOwner('x'.repeat(16385), 'user_hamed')).toThrow();
    expect(() => starterPilotForOwner(JSON.stringify([entry, entry]), 'user_hamed')).toThrow();
  });
});
