import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { WhatsAppConfig } from './config.js';
import { parseWhatsAppMessages, verifyWhatsAppSignature, WhatsAppInvalidEventError } from './cloud-api.js';
import { WhatsAppRepositoryError, type createWhatsAppRepository } from './repository.js';
import type { WhatsAppService } from './service.js';
import { whatsappConnectPage } from './connect-page.js';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const claimSchema = z.object({ token: tokenSchema }).strict();
const confirmSchema = claimSchema.extend({ code: z.string().regex(/^\d{6}$/), consentVersion: z.literal('whatsapp-general-agent-v1') }).strict();
const challengeSchema = z.object({ mode: z.literal('subscribe'), token: z.string().min(1).max(256), challenge: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) });

export function createWhatsAppRoutes(deps: {
  config: WhatsAppConfig; repository: ReturnType<typeof createWhatsAppRepository>; service: WhatsAppService;
  authenticate: (bearer: string) => Promise<string | null>; publishableKey: string; now?: () => number;
  logError?: (error: unknown) => void;
}) {
  const app = new Hono<{ Variables: { whatsappOwner: string } }>();
  const log = deps.logError ?? ((error) => console.error('[whatsapp] Request failed', error));
  app.use('/whatsapp/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next(); });
  app.use('/api/whatsapp/*', bodyLimit({ maxSize: 4096 }));
  app.use('/api/whatsapp/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'GET' && c.req.header('Origin') !== deps.config.publicUrl) return c.json({ error: 'Request denied' }, 403);
    const bearer = c.req.header('Authorization')?.match(/^Bearer ([^\s]{1,8192})$/)?.[1];
    if (!bearer) return c.json({ error: 'Sign in to continue' }, 401);
    try {
      const owner = await deps.authenticate(bearer);
      if (!owner) return c.json({ error: 'Sign in to continue' }, 401);
      c.set('whatsappOwner', owner);
    } catch (error) { log(error); return c.json({ error: 'Connection unavailable' }, 503); }
    await next();
  });
  app.get('/whatsapp/webhook', (c) => {
    const parsed = challengeSchema.safeParse({ mode: c.req.query('hub.mode'), token: c.req.query('hub.verify_token'), challenge: c.req.query('hub.challenge') });
    if (!parsed.success) return c.text('Request denied', 403);
    const actual = Buffer.from(parsed.data.token); const expected = Buffer.from(deps.config.verifyToken);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.text('Request denied', 403);
    return c.text(parsed.data.challenge);
  });
  app.post('/whatsapp/webhook', bodyLimit({ maxSize: 262144 }), async (c) => {
    let messages;
    try {
      const raw = await c.req.text();
      if (!verifyWhatsAppSignature(raw, c.req.header('x-hub-signature-256'), deps.config.appSecret)) return c.json({ error: 'Request denied' }, 401);
      messages = parseWhatsAppMessages(raw, deps.config.phoneNumberId);
    } catch (error) {
      // Hono's streamed-body limit error is not exported; use its established
      // discriminator, as in the platform MCP routes, before operational errors.
      if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'Request too large' }, 413);
      if (error instanceof WhatsAppInvalidEventError) return c.json({ error: 'Invalid event' }, 400);
      log(error); return c.json({ error: 'Delivery unavailable' }, 503);
    }
    try { await deps.service.ingest(messages); return c.json({ received: true }); }
    catch (error) { log(error); return c.json({ error: 'Delivery unavailable' }, 503); }
  });
  app.get('/whatsapp/connect', (c) => {
    const nonce = randomBytes(16).toString('hex');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', `default-src 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-${nonce}' https://clerk.matrix-os.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://clerk.matrix-os.com; img-src 'self' data: https://img.clerk.com https://clerk.matrix-os.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'`);
    return c.html(whatsappConnectPage(deps.publishableKey, nonce));
  });
  function failure(c: import('hono').Context, error: unknown) {
    if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'Request too large' }, 413);
    if (error instanceof WhatsAppRepositoryError && error.code === 'capacity') return c.json({ error: 'Connection is busy. Please retry this step shortly.' }, 503);
    if (error instanceof WhatsAppRepositoryError) return c.json({ error: 'Could not connect. Request a fresh link and try again.' }, error.code === 'conflict' ? 409 : 403);
    log(error); return c.json({ error: 'Connection unavailable' }, 503);
  }
  async function inputBody(c: import('hono').Context): Promise<unknown> {
    try { return await c.req.json(); }
    catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  app.post('/api/whatsapp/claim', async (c) => {
    try {
      const input = claimSchema.safeParse(await inputBody(c));
      if (!input.success) return c.json({ error: 'Invalid request' }, 400);
      return c.json(await deps.repository.claim(input.data.token, c.get('whatsappOwner')));
    }
    catch (error) { return failure(c, error); }
  });
  app.post('/api/whatsapp/confirm', async (c) => {
    try {
      const input = confirmSchema.safeParse(await inputBody(c));
      if (!input.success) return c.json({ error: 'Invalid request' }, 400);
      const connection = await deps.repository.confirm(input.data.token, c.get('whatsappOwner'), input.data.code, input.data.consentVersion);
      return c.json({ connected: true, maskedSender: /^\d+$/.test(connection.sender) ? `••••${connection.sender.slice(-4)}` : 'your WhatsApp account' });
    } catch (error) { return failure(c, error); }
  });
  app.get('/api/whatsapp/connection', async (c) => {
    try {
      const connection = await deps.repository.getConnection(c.get('whatsappOwner'));
      return c.json(connection ? { connected: true, maskedSender: /^\d+$/.test(connection.sender) ? `••••${connection.sender.slice(-4)}` : 'your WhatsApp account' } : { connected: false });
    } catch (error) { return failure(c, error); }
  });
  app.delete('/api/whatsapp/connection', async (c) => {
    try { await deps.repository.disconnect(c.get('whatsappOwner')); return c.json({ disconnected: true }); }
    catch (error) { return failure(c, error); }
  });
  return app;
}
