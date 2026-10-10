import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateSiteForm, type SiteForm } from '@matrix-os/contracts';
/** Signed platform admission holds the publication lock until persistence completes. */
export function verifySiteSignature(raw:string,timestamp:string|undefined,signature:string|undefined,secret:string|undefined,now=Date.now()):boolean {
 if(!secret || !timestamp || !/^\d{13}$/.test(timestamp) || !signature || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(now-Number(timestamp))>30000)return false;
 const expected=createHmac('sha256',secret).update(timestamp+'.'+raw).digest();return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
export function validateSiteFields(form:SiteForm,fields:unknown):Record<string,unknown>{
 const result=validateSiteForm(form,fields);if(!result.success)throw result.error;return result.data;
}
