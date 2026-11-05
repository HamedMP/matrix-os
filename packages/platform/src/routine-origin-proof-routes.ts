import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RoutineBrowserTupleSchema, ROUTINE_CREATION_PROOF_HEADER, ROUTINE_ORIGIN_PROOF_HEADER } from '@matrix-os/contracts';
import { verifyRoutineBrowserProof } from './routine-origin-proof.js';
import { createRoutineProofVerificationGuard } from './routine-proof-verification-guard.js';
import { HTTPException } from 'hono/http-exception';
import type { BrowserApprovalMachineLookup } from './browser-approval-machine-lookup.js';
/** Verification transport only. It cannot mint a browser decision or accept a runtime bearer as one. */
export function createRoutineOriginVerificationRoutes(options: { platformSecret: string; lookup?: Pick<BrowserApprovalMachineLookup, 'resolveMachine'>; bodyTimeoutMs?: number }) {
  if (options.lookup && typeof options.lookup.resolveMachine !== 'function') throw new Error('Routine verification unavailable');
  const app = new Hono();
  app.use('/internal/containers/:handle/routine-origin/verify', async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
  app.post('/internal/containers/:handle/routine-origin/verify', createRoutineProofVerificationGuard(options), bodyLimit({ maxSize: 4000 }), async c => {
    const handle = c.req.param('handle');
    try {
      const tuple = RoutineBrowserTupleSchema.safeParse(await c.req.json());
      if (!tuple.success || tuple.data.handle !== handle) return c.json({error:'Invalid request'},400);
      const header = tuple.data.purpose === 'routine_creation_route' ? ROUTINE_CREATION_PROOF_HEADER : ROUTINE_ORIGIN_PROOF_HEADER;
      const verified = verifyRoutineBrowserProof(c.req.header(header),tuple.data,options.platformSecret);
      if (!verified) return c.json({error:'Approval unavailable'},403);
      const machine = await options.lookup!.resolveMachine(handle,tuple.data.runtimeSlot);
      if (verified.expiresAt <= Date.now() || !machine || machine.status !== 'running' || machine.machineId !== tuple.data.machineId
        || machine.clerkUserId !== tuple.data.ownerId || machine.runtimeSlot !== tuple.data.runtimeSlot) return c.json({error:'Approval unavailable'},403);
      return c.json({verified});
    } catch(error:unknown) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof SyntaxError) return c.json({error:'Invalid request'},400);
      console.warn('[routine-origin] Verification unavailable',error instanceof Error ? error.name : 'UnknownError');
      return c.json({error:'Approval unavailable'},503);
    }
  });
  return app;
}
