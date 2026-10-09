import { describe, expect, it } from 'vitest';
import { loadFundedAcceptanceScope, assertFundedAcceptanceIdentity } from '../../packages/platform/src/ai-funded-acceptance-scope.js';
const now = new Date('2026-10-09T14:00:00.000Z');
const scope = {
  ownerId: 'user_test', machineId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeSlot: 'pr-9999', runtimeTokenEpoch: 2, validThrough: '2026-10-09T14:30:00.000Z'
};
const env = { MATRIX_FUNDED_AI_ACCEPTANCE_SCOPE: JSON.stringify(scope), MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', PLATFORM_BACKGROUND_WORKERS_ENABLED: 'false' };
describe('optional exact runtime acceptance restriction', () => {
  it('defaults absent with unchanged composition eligibility', () => expect(loadFundedAcceptanceScope({}, now)).toBeUndefined());
  it('strictly validates and freezes the one tuple', () => {
    const loaded = loadFundedAcceptanceScope(env, now)!;
    expect(loaded).toEqual(scope);
    expect(Object.isFrozen(loaded)).toBe(true);
  });
  it.each([
    { runtimeTokenEpoch: 0 }, { runtimeTokenEpoch: 1.5 }, { machineId: 'machine_test' }, { runtimeSlot: '../../root' }, { extra: true }, { validThrough: '2026-10-09T15:00:00.001Z' }, { validThrough: '2026-10-09T14:30:00+00:00' }
  ])('rejects unsafe config %j', patch => {
    expect(() => loadFundedAcceptanceScope({ ...env, MATRIX_FUNDED_AI_ACCEPTANCE_SCOPE: JSON.stringify({ ...scope, ...patch }) }, now)).toThrow();
  });
  it.each(['PLATFORM_BACKGROUND_WORKERS_ENABLED', 'MATRIX_FUNDED_AI_RUNTIME_ENABLED', 'MATRIX_FUNDED_HOST_CONFIG_ENABLED', 'MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED', 'AI_FUNDED_PROMOTIONAL_GRANT_ENABLED'])('rejects contradictory %s', name => {
    expect(() => loadFundedAcceptanceScope({ ...env, [name]: 'true' }, now)).toThrow();
  });
  it('rejects misspelled enabling/disabling flags', () => {
    expect(() => loadFundedAcceptanceScope({ ...env, MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'TRUE' }, now)).toThrow();
  });
  it('requires background workers explicitly false and control enabled', () => {
    expect(() => loadFundedAcceptanceScope({ ...env, PLATFORM_BACKGROUND_WORKERS_ENABLED: undefined }, now)).toThrow();
    expect(() => loadFundedAcceptanceScope({ ...env, MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'false' }, now)).toThrow();
  });
  it('keeps expired config present on restart and denies new admission', () => {
    const loaded = loadFundedAcceptanceScope(env, new Date('2026-10-09T15:00:00.000Z'))!;
    expect(loaded).toEqual(scope);
    expect(() => assertFundedAcceptanceIdentity(loaded, scope, 2, new Date('2026-10-09T15:00:00.000Z'))).toThrow();
  });
  it.each([{ ownerId: 'other' }, { machineId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2' }, { runtimeSlot: 'primary' }])('rejects offscope identity %j', patch => {
    expect(() => assertFundedAcceptanceIdentity(scope, { ...scope, ...patch }, 2, now)).toThrow();
  });
  it('rejects absent/rotated epochs but admits exact fresh identity', () => {
    expect(() => assertFundedAcceptanceIdentity(scope, scope, undefined, now)).toThrow();
    expect(() => assertFundedAcceptanceIdentity(scope, scope, 3, now)).toThrow();
    expect(() => assertFundedAcceptanceIdentity(scope, scope, 2, now)).not.toThrow();
  });
});
