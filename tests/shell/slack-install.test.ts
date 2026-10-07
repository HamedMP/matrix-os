import { describe, expect, it, vi } from 'vitest';
import { startSlackInstallation, validateSlackInstallUrl } from '../../shell/src/lib/slack-install';
import { isPublicShellPath } from '../../shell/src/lib/proxy-routes';
const origin = 'https://app.matrix-os.com';
const consent = () => {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.search = new URLSearchParams({client_id:'123.456',scope:'chat:write',redirect_uri:origin+'/api/slack/oauth/callback',state:'s'.repeat(43)}).toString();
  return url.toString();
};
describe('authenticated Slack installation entry', () => {
  it('allows the exact entry before a computer is provisioned', () => {
    expect(isPublicShellPath('/slack/install')).toBe(true);
    expect(isPublicShellPath('/slack/install/anything')).toBe(false);
  });
  it('gets a fresh account session and starts a server-owned organization permit', async () => {
    const token = vi.fn().mockResolvedValue('own-token');
    const request = vi.fn().mockResolvedValue(Response.json({url:consent()}));
    expect(await startSlackInstallation('org_team',origin,token,request)).toEqual({status:'ready',url:consent()});
    expect(token).toHaveBeenCalledWith({skipCache:true});
    const [path,options] = request.mock.calls[0];
    expect(path).toBe('/api/slack/install');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({organizationId:'org_team'});
    expect(options.headers.authorization).toBe('Bearer own-token');
    expect(options.credentials).toBe('omit');
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('does not start without an organization or signed-in session', async () => {
    const request=vi.fn();
    expect(await startSlackInstallation('',origin,async()=> 'own',request)).toEqual({status:'organization_required'});
    expect(await startSlackInstallation('org_team',origin,async()=> null,request)).toEqual({status:'signed_out'});
    expect(request).not.toHaveBeenCalled();
  });
  it.each([[401,'signed_out'],[403,'forbidden'],[404,'unavailable'],[503,'unavailable']] as const)('contains %s errors',async(status,result)=>{
    expect(await startSlackInstallation('org_team',origin,async()=> 'own',vi.fn().mockResolvedValue(new Response('private error',{status})))).toEqual({status:result});
  });
  it.each(['https://evil.test/','https://slack.com@evil.test/oauth/v2/authorize', 'javascript:alert(1)', 'https://slack.com/oauth/v2/authorize?state='])('rejects unsafe or stateless navigation %s',url=>{
    expect(validateSlackInstallUrl(url,origin)).toBeNull();
  });
  it('rejects an unrelated callback, duplicate state and fragments',()=>{
    for(const mutation of [(url:URL)=>url.searchParams.set('redirect_uri','https://evil.test/callback'),(url:URL)=>url.searchParams.append('state','s'.repeat(43)),(url:URL)=>url.hash='ignored']) {
      const url=new URL(consent()); mutation(url);expect(validateSlackInstallUrl(url.toString(),origin)).toBeNull();
    }
  });
  it('contains network, malformed responses and refresh failure', async()=>{
    for(const request of [vi.fn().mockRejectedValue(new Error('private error')),vi.fn().mockResolvedValue(Response.json({url:'https://evil.test'})),vi.fn().mockResolvedValue(new Response('invalid'))]) {
      expect(await startSlackInstallation('org_team',origin,async()=> 'own',request)).toEqual({status:'unavailable'});
    }
    expect(await startSlackInstallation('org_team',origin,async()=>{throw new Error('private error')},vi.fn())).toEqual({status:'unavailable'});
  });
  it('bounds stalled session refresh and clears the timer',async()=>{
    vi.useFakeTimers();try {
      const request=vi.fn();const pending=startSlackInstallation('org_team',origin,()=>new Promise(()=>{}),request);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({status:'unavailable'});expect(request).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
});
