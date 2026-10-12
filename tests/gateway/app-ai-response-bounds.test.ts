import { expect, it, vi } from 'vitest';
import { generateApiAppText } from '../../packages/gateway/src/app-ai/api-completion.js';
it('bounds empty/churning response chunks on the shared funded HTTP executor', async () => {
  let pulls=0;const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array());if(pulls===20000)controller.close();},cancel});
  const fetchImpl=vi.fn(async()=>new Response(body));
  await expect(generateApiAppText({homePath:'/unused',route:{harnessId:'matrix_ai',accountId:null,accessSourceId:'matrix_cloudflare',modelId:'fixture'},prompt:'text',signal:new AbortController().signal,revalidate:async()=>true,fundedCredentialProvider:{enabled:true,getCredential:async()=>({token:'fixture',relayBaseUrl:'https://relay.invalid'})} as never,fetchImpl})).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();expect(pulls).toBeLessThan(20000);
});
