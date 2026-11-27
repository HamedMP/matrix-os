import { describe, expect, it } from 'vitest';
import { parseIntegrationConnectResponse, parseIntegrationAttemptStatus, isCompletedIntegrationAttempt } from '../../packages/contracts/src/integration-connections.js';
const id = '123e4567-e89b-42d3-a456-426614174000';
describe('integration attempt metadata', () => {
  it('keeps a valid receipt separate from legacy consent and rejects malformed supplied IDs', () => {
    expect(parseIntegrationConnectResponse({ url: 'https://pipedream.com/connect', attemptId: id })).toEqual({ url: 'https://pipedream.com/connect', attemptId: id });
    expect(parseIntegrationConnectResponse({ url: 'https://example.com' })).toEqual({ url: 'https://example.com' });
    expect(parseIntegrationConnectResponse({ url: 'https://example.com', attemptId: 'bad' })).toBeNull();
  });
  it('returns only coarse receipt fields', () => {
    expect(parseIntegrationAttemptStatus({ status: 'succeeded', accountId: id, nonce: 'private' })).toEqual({ status: 'succeeded', accountId: id });
    expect(parseIntegrationAttemptStatus({ status: 'succeeded' })).toBeNull();
    expect(parseIntegrationAttemptStatus({ error: 'unavailable' })).toBeNull();
  });
  it('requires the receipt canonical account and never substitutes timestamp or inventory changes', () => {
    const account = { id, service: 'gmail', status: 'active', connectedAt: '2099-01-01' };
    expect(isCompletedIntegrationAttempt({ status: 'pending' }, 'gmail', [account])).toBe(false);
    expect(isCompletedIntegrationAttempt({ status: 'expired' }, 'gmail', [account])).toBe(false);
    expect(isCompletedIntegrationAttempt({ status: 'succeeded', accountId: id }, 'gmail', [account])).toBe(true);
    expect(isCompletedIntegrationAttempt({ status: 'succeeded', accountId: id }, 'gmail', [{ ...account, id: 'other' }])).toBe(false);
    expect(isCompletedIntegrationAttempt({ status: 'succeeded', accountId: id }, 'gmail', [{ ...account, service: 'slack' }])).toBe(false);
  });
});
