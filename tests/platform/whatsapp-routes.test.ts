import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readWhatsAppConfig } from '../../packages/platform/src/whatsapp/config.js';
import { createWhatsAppRoutes } from '../../packages/platform/src/whatsapp/routes.js';
import { WhatsAppRepositoryError, type createWhatsAppRepository } from '../../packages/platform/src/whatsapp/repository.js';
import type { WhatsAppService } from '../../packages/platform/src/whatsapp/service.js';

const origin = 'https://app.example.com';
const token = 'a'.repeat(43);
const config = readWhatsAppConfig({ WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'verify-secret',
  WHATSAPP_ACCESS_TOKEN: 'private-token', WHATSAPP_PHONE_NUMBER_ID: '123456', WHATSAPP_GRAPH_API_VERSION: 'v25.0',
  WHATSAPP_ENCRYPTION_KEY: 'a'.repeat(64), WHATSAPP_PUBLIC_URL: origin, WHATSAPP_ALLOWED_SENDERS: '46701234567' })!;
const connection = { id: 'connection', owner: 'owner', sender: '46701234567', consentVersion: 'whatsapp-general-agent-v1', chatId: null, machineId: null };
let repository: ReturnType<typeof createWhatsAppRepository>;
let service: WhatsAppService;
let authenticate: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.fn>;
let routes: ReturnType<typeof createWhatsAppRoutes>;
beforeEach(() => {
  repository = { claim: vi.fn(async () => ({ maskedSender: '••••4567' })), confirm: vi.fn(async () => connection),
    getConnection: vi.fn(async () => null), disconnect: vi.fn(async () => {}) } as unknown as typeof repository;
  service = { ingest: vi.fn(async () => {}) } as unknown as WhatsAppService;
  authenticate = vi.fn(async () => 'owner'); log = vi.fn();
  routes = createWhatsAppRoutes({ config, repository, service, authenticate, publishableKey: 'pk_test_example', logError: log });
});
function call(path: string, method = 'GET', payload?: unknown, headers = {}) {
  return routes.request(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: { authorization: 'Bearer owner-token', origin, 'content-type': 'application/json', ...headers } });
}
function event(raw: string) {
  return routes.request('/whatsapp/webhook', { method: 'POST', body: raw, headers: {
    'x-hub-signature-256': `sha256=${createHmac('sha256', config.appSecret).update(raw).digest('hex')}`,
  } });
}
describe('WhatsApp route authority and failures', () => {
  it.each(['/api/whatsapp/claim', '/api/whatsapp/confirm'])(
    'rejects oversized authenticated streams on %s before any linking mutation', async (path) => {
      const response = await routes.request(path, { method: 'POST', body: JSON.stringify({ token, code: '123456',
        consentVersion: 'whatsapp-general-agent-v1', padding: 'x'.repeat(4096) }),
      headers: { authorization: 'Bearer owner-token', origin, 'content-type': 'application/json' } });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Request too large' });
      expect(authenticate).toHaveBeenCalledWith('owner-token');
      expect(repository.claim).not.toHaveBeenCalled();
      expect(repository.confirm).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );
  it('preserves 413 for oversized webhook streams without ingestion or operational-error logs', async () => {
    for (const headers of [{}, { 'content-length': '262145' }]) {
      const response = await routes.request('/whatsapp/webhook', { method: 'POST', body: 'x'.repeat(262145), headers });
      expect(response.status).toBe(413);
      expect(await response.text()).not.toContain('Delivery unavailable');
    }
    expect(service.ingest).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it('returns a logged generic retryable failure for unexpected signed-event parsing errors', async () => {
    const diagnostic = new Error('private parser infrastructure failure');
    const raw = '{"object":"whatsapp_business_account","entry":[]}';
    const parse = JSON.parse;
    const parser = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text === raw) throw diagnostic;
      return parse(text, reviver);
    });
    let response: Response;
    try { response = await event(raw); }
    finally { parser.mockRestore(); }
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Delivery unavailable' });
    expect(log).toHaveBeenCalledWith(diagnostic);
    expect(service.ingest).not.toHaveBeenCalled();
  });
  it('returns a logged generic retryable failure when reading the webhook body fails', async () => {
    const diagnostic = new Error('private webhook body stream failure');
    const body = vi.spyOn(Request.prototype, 'text').mockRejectedValueOnce(diagnostic);
    let response: Response;
    try { response = await event('{"object":"whatsapp_business_account","entry":[]}'); }
    finally { body.mockRestore(); }
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Delivery unavailable' });
    expect(log).toHaveBeenCalledWith(diagnostic);
    expect(service.ingest).not.toHaveBeenCalled();
  });
  it('distinguishes request-body transport failures from malformed user JSON', async () => {
    const diagnostic = new Error('private body stream failure');
    const json = vi.spyOn(Request.prototype, 'text');
    try {
      for (const path of ['/api/whatsapp/claim', '/api/whatsapp/confirm']) {
        json.mockRejectedValueOnce(diagnostic);
        const response = await call(path, 'POST', { token });
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain(diagnostic.message);
      }
      expect(log).toHaveBeenCalledWith(diagnostic);
      expect(repository.claim).not.toHaveBeenCalled();
      expect(repository.confirm).not.toHaveBeenCalled();
    } finally { json.mockRestore(); }
  });
  it('keeps operational diagnostics server-side when no custom logger is configured', async () => {
    const diagnostic = new Error('private authentication outage');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      routes = createWhatsAppRoutes({ config, repository, service, authenticate, publishableKey: 'pk_test_example' });
      authenticate.mockRejectedValueOnce(diagnostic);
      const response = await call('/api/whatsapp/connection');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(diagnostic.message);
      expect(stderr).toHaveBeenCalledWith('[whatsapp] Request failed', diagnostic);
    } finally { stderr.mockRestore(); }
  });
  it('requires a verified Bearer principal and denies verifier outages without exposing details', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce(null);
    expect((await call('/api/whatsapp/connection')).status).toBe(401);
    authenticate.mockRejectedValueOnce(new Error('private authentication diagnostic'));
    const unavailable = await call('/api/whatsapp/connection');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('private authentication diagnostic');
    expect(log).toHaveBeenCalledOnce();
    expect(repository.getConnection).not.toHaveBeenCalled();
  });
  it('rejects invalid claim and confirm bodies before repository mutations', async () => {
    expect((await call('/api/whatsapp/claim', 'POST', { token: 'wrong' })).status).toBe(400);
    expect((await call('/api/whatsapp/confirm', 'POST', { token, code: 'bad', consentVersion: 'whatsapp-general-agent-v1' })).status).toBe(400);
    const malformed = await routes.request('/api/whatsapp/claim', { method: 'POST', body: '{', headers: { authorization: 'Bearer owner-token', origin } });
    expect(malformed.status).toBe(400);
    expect(repository.claim).not.toHaveBeenCalled(); expect(repository.confirm).not.toHaveBeenCalled();
  });
  it('maps proof conflicts and capacity failures while logging unknown failures only server-side', async () => {
    for (const [code, status] of [['conflict', 409], ['capacity', 503], ['invalid_link', 403]] as const) {
      vi.mocked(repository.claim).mockRejectedValueOnce(new WhatsAppRepositoryError(code));
      expect((await call('/api/whatsapp/claim', 'POST', { token })).status).toBe(status);
    }
    vi.mocked(repository.claim).mockRejectedValueOnce(new Error('private database diagnostic'));
    const failed = await call('/api/whatsapp/claim', 'POST', { token });
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('private database diagnostic');
    expect(log).toHaveBeenCalledOnce();
    vi.mocked(repository.confirm).mockRejectedValueOnce(new WhatsAppRepositoryError('invalid_link'));
    expect((await call('/api/whatsapp/confirm', 'POST', { token, code: '123456', consentVersion: 'whatsapp-general-agent-v1' })).status).toBe(403);
  });
  it('keeps capacity guidance retryable for the existing confirmation proof', async () => {
    vi.mocked(repository.confirm).mockRejectedValueOnce(new WhatsAppRepositoryError('capacity'));
    const response = await call('/api/whatsapp/confirm', 'POST', { token, code: '123456', consentVersion: 'whatsapp-general-agent-v1' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Connection is busy. Please retry this step shortly.' });
  });
  it('returns masked connection state and disconnects only the verified owner', async () => {
    expect(await (await call('/api/whatsapp/connection')).json()).toEqual({ connected: false });
    vi.mocked(repository.getConnection).mockResolvedValueOnce(connection as never);
    expect(await (await call('/api/whatsapp/connection')).json()).toEqual({ connected: true, maskedSender: '••••4567' });
    vi.mocked(repository.getConnection).mockResolvedValueOnce({ ...connection, sender: 'SE.opaqueSender' } as never);
    expect(await (await call('/api/whatsapp/connection')).json()).toEqual({ connected: true, maskedSender: 'your WhatsApp account' });
    vi.mocked(repository.confirm).mockResolvedValueOnce({ ...connection, sender: 'SE.opaqueSender' } as never);
    expect(await (await call('/api/whatsapp/confirm', 'POST', { token, code: '123456', consentVersion: 'whatsapp-general-agent-v1' })).json())
      .toEqual({ connected: true, maskedSender: 'your WhatsApp account' });
    expect(await (await call('/api/whatsapp/connection', 'DELETE')).json()).toEqual({ disconnected: true });
    expect(repository.disconnect).toHaveBeenCalledWith('owner');
    vi.mocked(repository.getConnection).mockRejectedValueOnce(new Error('private lookup failure'));
    expect((await call('/api/whatsapp/connection')).status).toBe(503);
    vi.mocked(repository.disconnect).mockRejectedValueOnce(new Error('private deletion failure'));
    expect((await call('/api/whatsapp/connection', 'DELETE')).status).toBe(503);
  });
  it('rejects malformed Meta challenges/events and returns retriable errors for ingress failure', async () => {
    expect((await routes.request('/whatsapp/webhook')).status).toBe(403);
    expect((await routes.request('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=%2F')).status).toBe(403);
    expect((await event('{')).status).toBe(400);
    expect((await event('{"object":"wrong"}')).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
    vi.mocked(service.ingest).mockRejectedValueOnce(new Error('private enqueue failure'));
    const response = await event('{"object":"whatsapp_business_account","entry":[]}');
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private enqueue failure');
    expect(log).toHaveBeenCalledOnce();
  });
});
