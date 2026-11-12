import { CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT, ChatGptPlanPeerReplySchema } from '@matrix-os/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod/v4';
import type { RequestPrincipal } from '../request-principal.js';
import { hasVerifiedRuntimeBearer, isRequestPrincipalError, mapRequestPrincipalError } from '../request-principal.js';
import { ChatGptPlanPeerError, type ChatGptPlanPeers } from './chatgpt-plan-peers.js';
import { emitPeerPoll, readPeerControlBody } from './chatgpt-plan-poll-route.js';

import { createPeerReplyIngress } from './chatgpt-plan-reply-route.js';

const challengeBody = z.object({}).strict();
const capabilitiesQuery = z.object({
  includeReplyDeliveryV2: z.tuple([z.literal('true')]).optional(),
  includeInferenceStream: z.tuple([z.literal('true')]).optional(),
  includeApprovedRoutines: z.tuple([z.literal('true')]).optional(),
});
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
  const replyIngress = createPeerReplyIngress();
  routes.use(`${root}/reply`, replyIngress.guard(c => { const { ownerId, peers } = authorized(c); peers.authorizeReply(ownerId); }));
  routes.use(`${root}/reply`, bodyLimit({
    maxSize: CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT,
    onError: c => c.json({ code: 'invalid_request', message: 'The request is too large.' }, 413),
  }));
  routes.use(`${root}/*`, async (c, next) => {
    if (c.req.path === `${root}/reply`) return next();
    const small = c.req.path === `${root}/capabilities` || c.req.path === `${root}/poll-v2`;
    return bodyLimit({ maxSize: small ? 512 : 1100000, onError: c => c.json({ code: 'invalid_request', message: 'The request is too large.' }, 413) })(c, next);
  });
  routes.onError((error: unknown, c) => {
    if (replyIngress.interrupted(c)) return c.json({ code: 'unavailable', message: 'This connection is unavailable.' }, 503);
    if (replyIngress.oversized(c) || error instanceof HTTPException && error.status === 413) {
      return c.json({ code: 'invalid_request', message: 'The request is too large.' }, 413);
    }
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
  routes.post(`${root}/rebind-challenge`, async c => {
    const { ownerId, peers } = authorized(c);
    challengeBody.parse(await c.req.json());
    return c.json(await peers.rebindChallenge(ownerId));
  });
  routes.post(`${root}/connect`, async c => {
    const { ownerId, peers } = authorized(c);
    return c.json(await peers.connect(ownerId, await c.req.json()));
  });
  routes.post(`${root}/poll`, async c => {
    const { ownerId, peers } = authorized(c);
    return c.json(await peers.poll(ownerId, await c.req.json()));
  });
  routes.post(`${root}/capabilities`, async c => {
    const { ownerId, peers } = authorized(c);
    const query = capabilitiesQuery.safeParse(c.req.queries());
    if (!query.success) throw new ChatGptPlanPeerError('invalid_request');
    return c.json(peers.capabilities(ownerId, await readPeerControlBody(c.req.raw),
      Boolean(query.data.includeReplyDeliveryV2), Boolean(query.data.includeInferenceStream), Boolean(query.data.includeApprovedRoutines)));
  });
  routes.post(`${root}/poll-v2`, async c => {
    const { ownerId, peers } = authorized(c);
    const emission = await peers.pollV2(ownerId, await readPeerControlBody(c.req.raw), c.req.raw.signal);
    return emitPeerPoll(c, emission);
  });
  routes.post(`${root}/reply`, async c => {
    const { ownerId, peers } = authorized(c);
    const reply = ChatGptPlanPeerReplySchema.parse(await c.req.json());
    const ack = await replyIngress.wait(c, reply.sessionId, reply.id, () => peers.reply(ownerId, reply, replyIngress.signal(c)));
    return replyIngress.emit(c, ack);
  });
  routes.post(`${root}/disconnect`, async c => {
    const { ownerId, peers } = authorized(c);
    return c.json(peers.disconnect(ownerId, await c.req.json()));
  });
  return routes;
}
