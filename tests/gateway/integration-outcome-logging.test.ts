import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrationActionFailure, integrationActionSuccess } from '../../packages/gateway/src/integrations/call-outcome.js';
import { IntegrationActionNotImplementedError } from '../../packages/gateway/src/integrations/action-execution.js';
import { GoogleCollectionRefusedError } from '../../packages/gateway/src/integrations/collection-hook.js';

const secret = 'synthetic-token-mail-body-and-private-account';
function sdkError(message = 'provider failure') {
  return Object.assign(new Error(`${message}: ${secret}`, { cause: new Error(secret) }), {
    name: secret, rawResponse: { body: secret, headers: { authorization: secret } },
    request: { url: `https://example.invalid/${secret}`, body: secret, authorization: secret },
  });
}
afterEach(() => vi.restoreAllMocks());
const expected = (operation: string, classification: string) => [['[integrations] operation failed', { operation, classification }]];
describe('integration outcome diagnostics exclude provider and request data', () => {
  it.each([
    { label: 'unknown SDK failure', error: () => sdkError(), status: 502, classification: 'failure' },
    { label: 'connection failure', error: () => sdkError('ECONNREFUSED'), status: 503, classification: 'connection' },
    { label: 'timeout', error: () => sdkError('timed out'), status: 504, classification: 'timeout' },
    { label: 'non-error SDK rejection', error: () => ({ message: secret, name: secret, rawResponse: { body: secret } }), status: 502, classification: 'non_error_failure' },
    { label: 'missing action', error: () => new IntegrationActionNotImplementedError(secret, secret), status: 501, classification: 'unimplemented' },
  ])('logs only fixed operation/classification for $label', async ({ error, status, classification }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new Hono(); app.get('/', c => integrationActionFailure(c, error(), secret, secret));
    const response = await app.request('/'); expect(response.status).toBe(status);
    expect(log.mock.calls).toEqual(expected('action', classification));
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret); expect(await response.text()).not.toContain(secret);
  });
  it.each([true, false])('keeps usage accounting best effort without raw DB rejection (Error=%s)', async isError => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined); const release = vi.fn(async () => undefined);
    const app = new Hono(); app.get('/', c => integrationActionSuccess(c, {
      db: { touchServiceUsage: async () => { throw isError ? sdkError() : { sql: secret, name: secret, cause: secret }; } },
      connectionId: secret, service: 'gmail', action: 'get_message', data: { synthetic: true }, beforeRelease: release,
    }));
    const response = await app.request('/'); expect(response.status).toBe(200); expect(release).toHaveBeenCalledOnce();
    expect(log.mock.calls).toEqual(expected('usage_update', isError ? 'failure' : 'non_error_failure'));
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret); expect(await response.json()).toMatchObject({ data: { synthetic: true } });
  });
  it('does not log policy refusal or a rate-limit SDK payload', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const limited = Object.assign(sdkError(), { statusCode: 429, rawResponse: { body: secret, headers: { get: () => '17' } } });
    const app = new Hono(); app.get('/policy', c => integrationActionFailure(c, new GoogleCollectionRefusedError(), secret, secret));
    app.get('/rate', c => integrationActionFailure(c, limited, secret, secret));
    expect((await app.request('/policy')).status).toBe(503);
    const response = await app.request('/rate'); expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('17');
    expect(log).not.toHaveBeenCalled(); expect(await response.text()).not.toContain(secret);
  });
});
