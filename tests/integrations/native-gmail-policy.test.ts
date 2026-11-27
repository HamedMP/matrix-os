import { describe, expect, it } from 'vitest';
import { loadNativeGmailPilotIds } from '../../packages/gateway/src/integrations/native-gmail/policy.js';
describe('bounded Gmail pilot operator configuration', () => {
  it('defaults empty to deny and trims immutable Clerk identities', () => {
    expect(loadNativeGmailPilotIds(undefined)).toEqual([]);
    expect(loadNativeGmailPilotIds('  ')).toEqual([]);
    const ids = loadNativeGmailPilotIds(' user_one , user_two ');
    expect(ids).toEqual(['user_one', 'user_two']); expect(Object.isFrozen(ids)).toBe(true);
  });
  it('accepts the exact maximum unique ID count and per-ID length', () => {
    expect(loadNativeGmailPilotIds(Array.from({ length: 100 }, (_, i) => `user_${String(i).padStart(123, 'a')}`).join(',')).length).toBe(100);
  });
  it.each(['user_one,user_one', 'user_one,', ',user_one', 'user_with_underscore', 'user_', 'owner@example.test',
    `user_${'a'.repeat(124)}`, ' '.repeat(12_900), 'user_one,'.repeat(1600)])('rejects invalid or unbounded IDs', value => {
    expect(() => loadNativeGmailPilotIds(value)).toThrow('Invalid Gmail pilot configuration');
  });
});
