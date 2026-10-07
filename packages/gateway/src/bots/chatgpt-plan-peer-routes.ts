import { CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT } from '@matrix-os/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { RequestPrincipal } from '../request-principal.js';
import { hasVerifiedRuntimeBearer, isRequestPrincipalError, mapRequestPrincipalError } from '../request-principal.js';
import { ChatGptPlanPeerError, type ChatGptPlanPeers } from './chatgpt-plan-peers.js';

const challengeBody = z.object({}).strict();
const failureStatus = { forbidden: 403, invalid_request: 400, unavailable: 503, conflict: 409 } as const;

export function createChatGptPlanPeerRoutes(options: {
  peers?: ChatGptPlanPeers;
  getPrincipal(c: Context): RequestPrincipal;
}) {
  const routes = new Hono();
  const root = '/api/chatgpt-plan/device';
  routes.use(`${root}/*`, async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  routes.use(`${root}/reply`, bodyLimit({
    maxSize: CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT,
    onError: c => c.json({ code: 'invalid_request', message: 'The request is too large.' }, 413),
  }));
  routes.use(`${root}/*`, async (c, next) => {
    if (c.req.path === `${root}/reply`) return next();
    return bodyLimit({ maxSize: 1100000, onError: c => c.json({ code: 'invalid_request', message: 'The request is too large.' }, 413) })(c, next);
  });
  routes.onError((error: unknown, c) => {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error);
      return c.json(mapped.body, mapped.status);
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return c.json({ code: 'invalid_request', message: 'The request is invalid.' }, 400);
    }
    if (error instanceof ChatGptPlanPeerError) {
      return c.json({ code: error.code, message: 'This connection is unavailable.' }, failureStatus[error.code]);
    }
    console.warn('[chatgpt-plan] Device request unavailable:', error instanceof Error ? error.name : 'UnknownError');
    return c.json({ code: 'unavailable', message: 'This connection is unavailable.' }, 503);
  });
  function authorized(c: Context) {
    const principal = options.getPrincipal(c);
    // Native bearer requests only. Browser cookie and dev-default sessions cannot enroll devices.
    if (!hasVerifiedRuntimeBearer(c) || principal.source === 'dev-default' || !c.req.header('authorization')?.startsWith('Bearer ')) {
      throw new ChatGptPlanPeerError('forbidden');
    }
    if (!options.peers) throw new ChatGptPlanPeerError('unavailable');
    return { ownerId: principal.userId, peers: options.peers };
  }
  routes.post(`${root}/challenge`, async c => {
    const { ownerId, peers } = authorized(c);
    challengeBody.parse(await c.req.json());
    return c.json(peers.challenge(ownerId));
  });
  routes.post(`${root}/connect`, async c => {
    const { ownerId, peers } = authorized(c);
    return c.json(await peers.connect(ownerId, await c.req.json()));
  });
  routes.post(`${root}/poll`, async c => {
    const { ownerId, peers } = authorized(c);
    return c.json(await peers.poll(ownerId, await c.req.json()));
  });
  routes.post(`${root}/reply`, async c => {
    const { ownerId, peers } = authorized(c);
    return c.json(peers.reply(ownerId, await c.req.json()));
  });
  routes.post(`${root}/disconnect`, async c => {
    const { ownerId, peers } = authorized(c);
    return c.json(peers.disconnect(ownerId, await c.req.json()));
  });
  return routes;
}
