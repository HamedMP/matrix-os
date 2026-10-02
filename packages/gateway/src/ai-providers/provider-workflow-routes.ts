import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { ProviderWorkflowStartSchema, ProviderWorkflowKeySchema, ProviderWorkflowCodeSchema } from '@matrix-os/contracts';
import { ProviderWorkflowError, type ProviderWorkflowService } from './provider-workflows.js';
const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export function createProviderWorkflowRoutes(options: {
  service: ProviderWorkflowService;
  getPrincipal: (c: Context) => {
    userId: string;
  } | null;
}) {
  if (!options.service || !options.getPrincipal)
    throw new Error('Workflow route dependencies required');
  const app = new Hono();
  app.use('/provider-settings/workflows/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
  app.use('/provider-settings/workflows', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
  app.use('/provider-settings/workflows/*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: { code: 'body_too_large', message: 'Request body is too large.' } }, 413) }));
  app.use('/provider-settings/workflows', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: { code: 'body_too_large', message: 'Request body is too large.' } }, 413) }));
  async function handle(c: Context, action: (owner: string) => unknown | Promise<unknown>) {
    try {
      const principal = options.getPrincipal(c);
      if (!principal)
        return c.json({ error: { code: 'unauthorized', message: 'Authentication is required.' } }, 401);
      return c.json(await action(principal.userId));
    }
    catch (error) {
      if (error instanceof ProviderWorkflowError) {
        const status = { unavailable: 503, not_found: 404, conflict: 409, rejected: 400, forbidden: 403 } as const;
        return c.json({ error: { code: error.code, message: error.code === 'rejected' ? 'The key could not be verified. Check it and try again.' : 'This operation is unavailable. Refresh and try again.' } }, status[error.code]);
      }
      console.warn('[provider-workflow] Request failed:', error instanceof Error ? error.name : 'UnknownError');
      return c.json({ error: { code: 'unavailable', message: 'This operation is unavailable. Refresh and try again.' } }, 503);
    }
  }
  async function json(c: Context) {
    try {
      return await c.req.json();
    }
    catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError')
        throw error;
      if (!(error instanceof SyntaxError))
        console.warn('[provider-workflow] Invalid body:', error instanceof Error ? error.name : 'UnknownError');
      return undefined;
    }
  }
  const invalid = (c: Context) => c.json({ error: { code: 'invalid_request', message: 'Invalid request.' } }, 400);
  app.get('/provider-settings/workflows/capabilities', c => {
    const version = z.enum(['1', '2']).optional().safeParse(c.req.query('connectionVersion'));
    if (!version.success) return invalid(c);
    return handle(c, async owner => {
      const capabilities = await options.service.capabilities(owner, version.data !== '2');
      return version.data === '2' ? capabilities : capabilities.map(row => ({ ...row,
        loginMethods: row.loginMethods.filter(method => method === 'device_code' || method === 'terminal') }));
    });
  });
  app.post('/provider-settings/workflows', async (c) => { const body = ProviderWorkflowStartSchema.safeParse(await json(c)); return body.success ? handle(c, owner => options.service.start(owner, body.data)) : invalid(c); });
  app.post('/provider-settings/workflows/keys', async (c) => { const body = ProviderWorkflowKeySchema.safeParse(await json(c)); return body.success ? handle(c, owner => options.service.verifyKey(owner, body.data)) : invalid(c); });
  app.get('/provider-settings/workflows/logs/:harnessInstanceId', c => { const id = ref.safeParse(c.req.param('harnessInstanceId')); return id.success ? handle(c, owner => options.service.logs(owner, id.data)) : invalid(c); });
  app.get('/provider-settings/workflows/:id', c => { const id = ref.safeParse(c.req.param('id')); return id.success ? handle(c, owner => options.service.status(owner, id.data)) : invalid(c); });
  app.post('/provider-settings/workflows/:id/code', async c => { const id = ref.safeParse(c.req.param('id')); const body = ProviderWorkflowCodeSchema.safeParse(await json(c)); return id.success && body.success ? handle(c, owner => options.service.submitCode(owner, id.data, body.data.code)) : invalid(c); });
  app.post('/provider-settings/workflows/:id/cancel', async (c) => { const id = ref.safeParse(c.req.param('id')); const body = z.object({}).strict().safeParse(await json(c)); return id.success && body.success ? handle(c, owner => options.service.cancel(owner, id.data)) : invalid(c); });
  return app;
}
