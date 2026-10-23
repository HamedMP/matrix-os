import { SHARED_BROWSER_ACTION_MAX_BYTES } from '../../packages/contracts/src/shared-browser.js';
import {expect,it,vi} from 'vitest';
import {callSharedBrowser} from '../../packages/gateway/src/chat/shared-browser-client.js';
it('rejects undeclared private fields at the native tool result boundary',async()=>{
  await expect(callSharedBrowser({gatewayPort:4000,token:'a'.repeat(43),action:{action:'status'},
    fetcher:async()=>Response.json({success:true,privateHeaders:{authorization:'synthetic-secret'}})})).rejects.toThrow();
});
it('uses the shared result contract for an explicit owner handoff',async()=>{
  expect(await callSharedBrowser({gatewayPort:4000,token:'a'.repeat(43),action:{action:'snapshot'},
    fetcher:async()=>Response.json({success:false,handoffRequested:true,elements:[],content:'Owner Take over required.'})}))
    .toMatchObject({success:false,handoffRequested:true});
});
it('allows the full owner pause and bounded browser action before timing out',async()=>{
  const timeouts=vi.spyOn(AbortSignal,'timeout');
  try {
    await callSharedBrowser({gatewayPort:4000,token:'a'.repeat(43),action:{action:'snapshot'},
      fetcher:async()=>Response.json({success:true})});
    expect(timeouts).toHaveBeenCalledWith(360_000);
  } finally { timeouts.mockRestore(); }
});

it.each(['中'.repeat(4000), '\u0000'.repeat(4000)])('sends maximum bounded native text unchanged',async(text)=>{
  const action={action:'type' as const,observationId:'o'.repeat(128),ref:'r'.repeat(128),text};
  await callSharedBrowser({gatewayPort:4000,token:'a'.repeat(43),action,fetcher:async(_url,init)=>{
    expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(SHARED_BROWSER_ACTION_MAX_BYTES);
    expect(JSON.parse(String(init?.body))).toEqual(action);return Response.json({success:true});
  }});
});

it('rejects oversized invalid action text before making a native request',async()=>{
  const fetcher=vi.fn();
  await expect(callSharedBrowser({gatewayPort:4000,token:'a'.repeat(43),
    action:{action:'type',observationId:'obs',ref:'r1',text:'x'.repeat(SHARED_BROWSER_ACTION_MAX_BYTES)},fetcher})).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
