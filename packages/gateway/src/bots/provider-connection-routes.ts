import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ChatAgentIdSchema, BotProviderConnectionIdSchema, BotProviderAuthorizationRequestSchema, BotExecutionBindingRequestSchema } from '@matrix-os/contracts';
import { BotProviderConnectionError, type BotProviderConnectionsService } from './provider-connections.js';
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from '../request-principal.js';
export function createBotProviderConnectionRoutes(options: { service?: BotProviderConnectionsService; getPrincipal(context: Context): RequestPrincipal }) {
  const routes = new Hono();
  for (const path of ['/api/bot-connections', '/api/bot-connections/:id/authorization', '/api/chat-agents/:agentId/execution']) {
    routes.use(path, async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
    routes.use(path, bodyLimit({ maxSize: 8192, onError: c => c.json({ code: 'invalid_request', message: 'The request is too large.' }, 413) }));
  }
  const unavailable = (c: Context) => c.json({ code: 'unavailable', message: 'This connection is unavailable. Refresh and try again.' }, 503);
  const invalid = (c: Context) => c.json({ code: 'invalid_request', message: 'The request is invalid.' }, 400);
  routes.onError((error: unknown, c) => {
    if (isRequestPrincipalError(error)) { const mapped = mapRequestPrincipalError(error); return c.json(mapped.body, mapped.status); }
    if (error instanceof SyntaxError) return invalid(c);
    if (error instanceof BotProviderConnectionError) {
      const status = { forbidden: 403, invalid_request: 400, unavailable: 503, conflict: 409, not_found: 404 } as const;
      return c.json({ code: error.code, message: 'This connection is unavailable. Refresh and try again.' }, status[error.code]);
    }
    console.warn('[bot-connections] Request unavailable:', error instanceof Error ? error.name : 'UnknownError'); return unavailable(c);
  });
  routes.get('/api/bot-connections', async c => {
    const principal = options.getPrincipal(c); const flag = c.req.query('includeChatgptPlan');
    if (flag !== undefined && flag !== 'true' && flag !== 'false') return invalid(c);
    return options.service ? c.json(await options.service.connections(principal.userId, flag === 'true')) : unavailable(c);
  });
  routes.post('/api/bot-connections/:id/authorization', async c => {
    const principal = options.getPrincipal(c); const id = BotProviderConnectionIdSchema.safeParse(c.req.param('id'));
    const body = BotProviderAuthorizationRequestSchema.safeParse(await c.req.json());
    if (!id.success || !body.success) return invalid(c);
    return options.service ? c.json(await options.service.authorize(principal.userId, id.data, body.data)) : unavailable(c);
  });
  routes.get('/api/chat-agents/:agentId/execution', async c => {
    const principal = options.getPrincipal(c); const id = ChatAgentIdSchema.safeParse(c.req.param('agentId'));
    if (!id.success) return invalid(c);
    return options.service ? c.json(await options.service.execution(principal.userId, id.data)) : unavailable(c);
  });
  routes.post('/api/chat-agents/:agentId/execution', async c => {
    const principal = options.getPrincipal(c); const id = ChatAgentIdSchema.safeParse(c.req.param('agentId'));
    const body = BotExecutionBindingRequestSchema.safeParse(await c.req.json());
    if (!id.success || !body.success) return invalid(c);
    return options.service ? c.json(await options.service.configure(principal.userId, id.data, body.data)) : unavailable(c);
  });
  return routes;
}
