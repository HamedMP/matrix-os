import { createRateLimiter } from '../security/rate-limiter.js';
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { CanonicalChatIdSchema, BotInteractionIdSchema, RoutineOriginDecisionSubmitSchema,
  RoutineOriginApprovalTupleSchema, RoutineChatOriginViewSchema, ResolveBotInteractionResponseSchema,
  ROUTINE_ORIGIN_PROOF_HEADER, type RoutineChatOriginView, type RoutineOriginDecisionSubmit,
  type ResolveBotInteractionResponse } from '@matrix-os/contracts';
import { BotInteractionError, type BotContinuation } from './interactions.js';
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from '../request-principal.js';
import type { createRoutineOriginPlatformClient, VerifiedRoutineOriginApproval } from './routine-origin-platform-client.js';
import type { BotContinuationAdmitter } from './continuations.js';
export interface RoutineOriginRouteService {
  read(ownerId:string,sourceChatId:string,includeHistory?:boolean):Promise<RoutineChatOriginView>;
  resolve(ownerId:string,sourceChatId:string,interactionId:string,request:RoutineOriginDecisionSubmit,
    verified:VerifiedRoutineOriginApproval):Promise<{response:ResolveBotInteractionResponse;continuation?:BotContinuation}>;
}
/** Source alias only. Canonical target mapping and decision remain atomic in the service. */
export function createRoutineOriginRoutes(options:{service:RoutineOriginRouteService;
  verifyApproval:ReturnType<typeof createRoutineOriginPlatformClient>['verifyApproval'];
  handle:string;runtimeSlot:string;machineId:string;getPrincipal(c:Context):RequestPrincipal;admitContinuation:BotContinuationAdmitter}) {
  if (typeof options.service?.read!=='function' || typeof options.service?.resolve!=='function'
    || typeof options.verifyApproval!=='function' || typeof options.getPrincipal!=='function' || typeof options.admitContinuation!=='function'
    || !options.handle || !options.runtimeSlot || !options.machineId) throw new Error('Routine origin routes unavailable');
  const app=new Hono<{ Variables: { originPrincipal: RequestPrincipal } }>();
  const limit = (maxAttempts: number) => createRateLimiter({ maxAttempts, windowMs: 60_000, lockoutMs: 0, maxKeys: 1024 });
  const reads = limit(120), decisions = limit(30);
  const unavailable=(c:Context,status:400|403|404|409|410|413|429|503=503)=>c.json({code:status===403?'permission_denied':status===409?'conflict':status===404?'not_found':'unavailable',message:'This task request is unavailable.'},status);
  app.use('/api/chats/:chatId/routine-origin*',async(c,next)=>{c.header('Cache-Control','private, no-store');
    const query = new URL(c.req.url).searchParams;
    if (query.size && !(c.req.method === 'GET' && c.req.path.endsWith('/routine-origin')
      && query.size === 1 && query.get('timeline') === '1')) return unavailable(c,400);
    const principal = options.getPrincipal(c);
    if (!(c.req.method === 'POST' ? decisions : reads).check(principal.userId)) return unavailable(c,429);
    c.set('originPrincipal', principal);
    await next();});
  app.onError((error:unknown,c)=>{
    if(isRequestPrincipalError(error)){const mapped=mapRequestPrincipalError(error);return c.json(mapped.body,mapped.status);}
    if(error instanceof z.ZodError || error instanceof SyntaxError)return unavailable(c,400);
    if(error instanceof BotInteractionError){const status={invalid_request:400,not_found:404,conflict:409,expired:410,rate_limited:429,unavailable:503} as const;return unavailable(c,status[error.code]);}
    console.warn('[routine-origin] Request unavailable',error instanceof Error ? error.name : 'UnknownError');return unavailable(c);
  });
  app.get('/api/chats/:chatId/routine-origin',async c=>{
    const principal=c.get('originPrincipal'),chatId=CanonicalChatIdSchema.parse(c.req.param('chatId'));
    const includeHistory = c.req.query('timeline') === '1';
    const { history, ...view } = RoutineChatOriginViewSchema.parse(await (includeHistory
      ? options.service.read(principal.userId, chatId, true)
      : options.service.read(principal.userId, chatId)));
    return c.json(includeHistory && history ? { ...view, history } : view);
  });
  app.post('/api/chats/:chatId/routine-origin/:interactionId/resolve',bodyLimit({maxSize:2048,onError:c=>unavailable(c,413)}),async c=>{
    const principal=c.get('originPrincipal'),sourceChatId=CanonicalChatIdSchema.parse(c.req.param('chatId')),
      interactionId=BotInteractionIdSchema.parse(c.req.param('interactionId'));
    const body=RoutineOriginDecisionSubmitSchema.parse(await c.req.json()),proof=c.req.header(ROUTINE_ORIGIN_PROOF_HEADER);
    if(!proof || proof.length>6000)return unavailable(c,403);
    const tuple=RoutineOriginApprovalTupleSchema.parse({...body,purpose:'routine_origin_approval',handle:options.handle,
      runtimeSlot:options.runtimeSlot,machineId:options.machineId,ownerId:principal.userId,sourceChatId,interactionId,
      method:'POST',path:`/api/chats/${sourceChatId}/routine-origin/${interactionId}/resolve`,
      bodyDigest:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
    let verified:VerifiedRoutineOriginApproval;
    try{verified=await options.verifyApproval(tuple,proof,c.req.raw.signal);}
    catch(error:unknown){console.warn('[routine-origin] Browser decision unavailable',error instanceof Error ? error.name : 'UnknownError');return unavailable(c,403);}
    const {response,continuation}=await options.service.resolve(principal.userId,sourceChatId,interactionId,body,verified);
    if(continuation)try{await options.admitContinuation(principal,continuation);}
    catch(error:unknown){
      console.warn('[routine-origin] Continuation unavailable',error instanceof Error ? error.name : 'UnknownError');
      return c.json(ResolveBotInteractionResponseSchema.parse({...response,continuationPending:true}));
    }
    return c.json(ResolveBotInteractionResponseSchema.parse(response));
  });
  return app;
}
