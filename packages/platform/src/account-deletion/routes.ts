import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { verifyClerkWebhookSignature } from '../organizations/webhook-signature.js';
import { getAccountDeletionPage } from './page.js';
import { AccountDeletionConflictError } from './repository.js';
import { AccountDeletionOwnershipError, type AccountDeletionService } from './types.js';

const Owner = z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/);
const Confirm = z.object({ confirm: z.literal(true) }).strict();
const DeletedEvent = z.object({type:z.literal('user.deleted'),data:z.object({id:Owner,deleted:z.literal(true)})});
export interface AccountDeletionExport {
  downloads: Array<{ name: string; url: string }>;
  migrationUrl: string;
  instructions?: string[];
  nextCursor?: string | null;
}
export function createAccountDeletionRoutes(options: {
  service?: AccountDeletionService;
  verify(token: string): Promise<string | null>;
  webhookSecret?: string;
  publishableKey?: string;
  exportData?(owner: string, cursor?: string): Promise<AccountDeletionExport>;
  exportPlatformData?(owner:string): Promise<unknown>;
  registerAppleAuthorization?(owner:string,code:string):Promise<void>;
}): Hono {
  const app = new Hono();
  app.use('*', async(c,next)=> { c.header('Cache-Control','private, no-store'); await next(); });
  const limit = bodyLimit({ maxSize:1024,onError:c=>c.json({error:'Request too large'},413) });
  const hookLimit = bodyLimit({ maxSize:64*1024,onError:c=>c.json({error:'Request too large'},413) });
  const unavailable = () => ({error:'Account deletion is unavailable. Please try again.'});
  async function actor(header: string | undefined): Promise<string | null> {
    if (!header?.startsWith('Bearer ') || header.length>8192) return null;
    try { const owner = await options.verify(header.slice(7)); return Owner.safeParse(owner).success ? owner : null; }
    catch(error:unknown) { console.warn('[account-deletion] authentication failed',error instanceof Error ? error.name : 'UnknownError'); return null; }
  }
  app.get('/account/delete',c=> {
    const nonce=randomBytes(16).toString('base64');
    c.header('X-Frame-Options','DENY');
    c.header('Referrer-Policy','no-referrer');
    c.header('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}' https://clerk.matrix-os.com; connect-src 'self' https://clerk.matrix-os.com; style-src 'unsafe-inline'; img-src 'self' data: https://img.clerk.com; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
    return c.html(getAccountDeletionPage({nonce,publishableKey:options.publishableKey}));
  });
  for (const path of ['/api/account/delete','/api/account/delete/export','/api/account/delete/export/platform'] as const) {
    app.get(path,async c=> {
      const owner=await actor(c.req.header('authorization'));
      if (!owner) return c.json({error:'Unauthorized'},401);
      if (!options.service) return c.json(unavailable(),503);
      try {
        if (path.includes('/export')) {
          const query=z.object({cursor:z.string().max(4096).optional()}).strict().safeParse(c.req.query());
          if(!query.success)return c.json({error:'Invalid request'},422);
          const status=await options.service.get(owner);
          if (status.status==='processing'||status.status==='completed'||(status.status==='scheduled'&&status.erasesAfter&&Date.parse(status.erasesAfter)<=Date.now())) return c.json({error:'Data is no longer available for download.'},409);
          if(path.endsWith('/platform')){if(!options.exportPlatformData)return c.json(unavailable(),503);c.header('Content-Disposition','attachment; filename="matrix-account.json"');return c.json(await options.exportPlatformData(owner));}
          if (!options.exportData) return c.json(unavailable(),503);
          return c.json(await options.exportData(owner,query.data.cursor));
        }
        return c.json(await options.service.get(owner));
      } catch(error:unknown) { console.error('[account-deletion] read failed',error instanceof Error ? error.name:'UnknownError'); return c.json(unavailable(),503); }
    });
  }
  for (const path of ['/api/account/delete','/api/account/delete/cancel'] as const) {
    app.post(path,limit,async c=> {
      const owner=await actor(c.req.header('authorization'));
      if (!owner) return c.json({error:'Unauthorized'},401);
      let payload:unknown;
      try { payload=await c.req.json(); }
      catch(error:unknown) { if (!(error instanceof SyntaxError)) throw error; return c.json({error:'Invalid request'},400); }
      if (!Confirm.safeParse(payload).success) return c.json({error:'Confirm the account deletion request.'},422);
      if (!options.service) return c.json(unavailable(),503);
      try {
        const status=path.endsWith('/cancel') ? await options.service.cancel(owner) : await options.service.schedule(owner);
        return c.json(status,path.endsWith('/cancel')||status.status==='completed'?200:202);
      } catch(error:unknown) {
        if (error instanceof AccountDeletionOwnershipError) return c.json({error:'Transfer organization and shared project ownership before deleting your account.',code:'ownership_transfer_required'},409);
        if (error instanceof AccountDeletionConflictError) return c.json({error:'Cancellation is not available at this stage.'},409);
        console.error('[account-deletion] request failed',error instanceof Error ? error.name:'UnknownError');
        return c.json(unavailable(),503);
      }
    });
  }
  app.post('/api/account/apple-token',bodyLimit({maxSize:8192,onError:c=>c.json({error:'Request too large'},413)}),async c=> {
    const owner=await actor(c.req.header('authorization'));
    if(!owner)return c.json({error:'Unauthorized'},401);
    let payload:unknown;
    try{payload=await c.req.json();}catch(error:unknown){if(!(error instanceof SyntaxError))throw error;return c.json({error:'Invalid request'},400);}
    const parsed=z.object({code:z.string().min(1).max(4096)}).strict().safeParse(payload);
    if(!parsed.success)return c.json({error:'Invalid request'},422);
    if(!options.registerAppleAuthorization)return c.json(unavailable(),503);
    try{await options.registerAppleAuthorization(owner,parsed.data.code);return c.json({stored:true});}
    catch(error:unknown){console.error('[account-deletion] Apple authorization capture failed',error instanceof Error?error.name:'UnknownError');return c.json(unavailable(),503);}
  });
  app.post('/webhooks/clerk/users',hookLimit,async c=> {
    if (!options.webhookSecret||!options.service) return c.json(unavailable(),503);
    const body=await c.req.text();
    const verified=verifyClerkWebhookSignature({signingSecret:options.webhookSecret,body,headers:c.req.header()});
    if (!verified.ok) return c.json({error:'Invalid webhook'},401);
    let payload:unknown;
    try { payload=JSON.parse(body); }
    catch(error:unknown) { if (!(error instanceof SyntaxError)) throw error; return c.json({error:'Invalid webhook'},400); }
    const kind=z.object({type:z.string().max(128)}).safeParse(payload);
    if (!kind.success) return c.json({error:'Invalid webhook'},422);
    if (kind.data.type!=='user.deleted') return c.json({received:true});
    const event=DeletedEvent.safeParse(payload);
    if (!event.success) return c.json({error:'Invalid webhook'},422);
    try { await options.service.schedule(event.data.data.id,true); return c.json({received:true}); }
    catch(error:unknown) { console.error('[account-deletion] webhook schedule failed',error instanceof Error ? error.name:'UnknownError'); return c.json(unavailable(),503); }
  });
  return app;
}
