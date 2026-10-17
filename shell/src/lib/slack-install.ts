import { SlackInstallRequestSchema, SlackOAuthCallbackQuerySchema } from '@matrix-os/contracts/slack-bridge';

export type SlackInstallResult = { status: 'ready'; url: string } | { status: 'organization_required' | 'signed_out' | 'forbidden' | 'unavailable' };

/** Navigate only to Slack consent with a nonce and the configured same-origin callback. */
export function validateSlackInstallUrl(value: unknown, appOrigin: string): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'slack.com' || url.port || url.username || url.password || url.hash || url.pathname !== '/oauth/v2/authorize') return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 4 || !['client_id','scope','redirect_uri','state'].every(key => url.searchParams.getAll(key).length === 1)) return null;
    if (!/^\d+\.\d+$/.test(url.searchParams.get('client_id') ?? '') || !url.searchParams.get('scope')) return null;
    if (!SlackOAuthCallbackQuerySchema.shape.state.safeParse(url.searchParams.get('state')).success) return null;
    const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
    if (callback.origin !== new URL(appOrigin).origin || callback.protocol !== 'https:' || callback.pathname !== '/api/slack/oauth/callback' || callback.search || callback.hash || callback.username || callback.password) return null;
    return url.toString();
  } catch (error: unknown) { if (error instanceof TypeError) return null; throw error; } // Invalid URLs are validation failures, never server lookups.
}

export async function startSlackInstallation(organizationId: string, appOrigin: string,
  getToken: (options: { skipCache: boolean }) => Promise<string | null>, fetchImpl: typeof fetch = fetch): Promise<SlackInstallResult> {
  const request = SlackInstallRequestSchema.safeParse({organizationId});
  if (!request.success) return {status:'organization_required'};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([getToken({skipCache:true}),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Session unavailable')),10_000);
    })]);
    if (!token) return {status:'signed_out'};
    const response=await fetchImpl('/api/slack/install',{
      method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify(request.data),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10_000),
    });
    if(response.status===401) return {status:'signed_out'};
    if(response.status===403) return {status:'forbidden'};
    if(!response.ok) return {status:'unavailable'};
    const payload: unknown=await response.json();
    const url=validateSlackInstallUrl(payload && typeof payload==='object' && 'url' in payload ? payload.url : null,appOrigin);
    return url ? {status:'ready',url} : {status:'unavailable'};
  } catch(error: unknown) {
    console.warn('[slack] installation unavailable',error instanceof Error ? error.name : 'UnknownError');
    return {status:'unavailable'};
  } finally {if(timer) clearTimeout(timer);}
}
