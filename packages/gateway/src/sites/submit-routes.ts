import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SiteSubmitCapabilitySchema } from '@matrix-os/contracts';
import { z } from 'zod/v4';
import type { SiteSubmissionRepository } from './submission-repository.js';
import { validateSiteFields, verifySiteSignature } from './submission-validation.js';
export function createSiteSubmitRoutes(options:{serviceSecret?:string;submissions:SiteSubmissionRepository|null}):Hono {
 const app=new Hono();
 app.post('/api/internal/sites/:siteId/submit',bodyLimit({maxSize:96*1024,onError:c=>c.json({error:'Too many requests'},413)}),async c=>{
  const siteId=z.uuid().safeParse(c.req.param('siteId'));if(!siteId.success)return c.json({error:'Invalid submission'},400);
  const raw=await c.req.text();
  if(!verifySiteSignature(raw,c.req.header('x-matrix-site-timestamp'),c.req.header('x-matrix-site-signature'),options.serviceSecret))return c.json({error:'Unauthorized'},401);
  let parsed:ReturnType<typeof SiteSubmitCapabilitySchema.safeParse>;
  try{parsed=SiteSubmitCapabilitySchema.safeParse(JSON.parse(raw));}catch(error){if(error instanceof SyntaxError)return c.json({error:'Invalid submission'},400);throw error;}
  if(!parsed.success || parsed.data.siteId!==siteId.data)return c.json({error:'Invalid submission'},400);
  const input=parsed.data;if(Buffer.byteLength(JSON.stringify(input.fields))>16*1024)return c.json({error:'Invalid submission'},400);
  const form=input.config.forms.find(form=>form.id===input.formId);if(!form)return c.json({error:'Invalid submission'},400);
  let fields:Record<string,unknown>;
  try{fields=validateSiteFields(form,input.fields);}catch(error){if(error instanceof z.ZodError)return c.json({error:'Invalid submission'},400);throw error;}
  if(!options.submissions)return c.json({error:'Submission unavailable'},503);
  try{await options.submissions.submit({...input,fields});return c.json({ok:true});}catch(error){console.warn('[sites] Submission persistence failed',error instanceof Error?error.name:'UnknownError');return c.json({error:'Submission unavailable'},503);}
 });return app;
}
