import { describe, expect, it, vi } from "vitest";
import { createFundedChatUsageTransport } from "../../packages/gateway/src/chat-usage-classifier-transport.js";
const snapshot={messages:[{role:"user" as const,text:"Explain a loop"}]};
const tags={taskFamily:"coding",taskType:"explain",complexity:"low"};
function setup(extra:Record<string,unknown>={}) {
  const provider={enabled:true,maxRunMs:60000,getCredential:vi.fn().mockResolvedValue({token:"test-only-token",tokenId:"test-token",relayBaseUrl:"https://relay.example.test",expiresAt:"2026-10-25T15:00:00.000Z",requestClass:"background",maxRunMs:60000}),invalidate:vi.fn(),close:vi.fn()};
  const fetcher=vi.fn().mockResolvedValue(Response.json({choices:[{message:{content:JSON.stringify(tags)}}]}));
  const classify=createFundedChatUsageTransport({provider:provider as never,relayBaseUrl:"https://relay.example.test",fetcher,...extra});
  return{provider,fetcher,classify};
}
describe("Matrix transient classification transport",()=>{
  it("uses only a fixed Matrix model, actual funded credentials, no content logs and no recursion hook",async()=>{
    const {classify,provider,fetcher}=setup();const controller=new AbortController();
    expect(await classify(snapshot,controller.signal)).toEqual(tags);
    expect(provider.getCredential).toHaveBeenCalledWith(expect.objectContaining({requestClass:"background",signal:expect.any(AbortSignal)}));
    const [url,init]=fetcher.mock.calls[0];expect(url).toBe("https://relay.example.test/v1/chat/completions");
    const body=JSON.parse(init.body);expect(body).toMatchObject({model:"@cf/openai/gpt-oss-20b",store:false,stream:false,max_tokens:512});
    expect(body.messages[1]).toEqual({role:"user",content:JSON.stringify(snapshot)});
    expect(init.redirect).toBe("error");expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers=new Headers(init.headers);expect(headers.get("authorization")).toBe("Bearer test-only-token");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(JSON.stringify(init)).not.toContain("ownerId");
  });
  it("never accepts an arbitrary credential destination or redirects",async()=>{
    const {classify,provider,fetcher}=setup();provider.getCredential.mockResolvedValue({token:"secret",relayBaseUrl:"https://attacker.example.test"} as never);
    await expect(classify(snapshot,new AbortController().signal)).rejects.toThrow("Classification unavailable");expect(fetcher).not.toHaveBeenCalled();
    expect(()=>setup({relayBaseUrl:"http://169.254.169.254"})).toThrow();
  });
  it("rejects malformed, extra-text and oversized outputs without retrying or exposing upstream errors",async()=>{
    for(const response of [Response.json({choices:[{message:{content:JSON.stringify({...tags,reason:"private"})}}]}),
      Response.json({choices:[{message:{content:"not json"}}]}), new Response("PRIVATE",{status:500}),new Response("x".repeat(20000))]) {
      const{classify,fetcher}=setup();fetcher.mockResolvedValue(response);
      await expect(classify(snapshot,new AbortController().signal)).rejects.toThrow("Classification unavailable");expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("refuses already-aborted work before acquiring credentials",async()=>{
    const{classify,provider}=setup();const controller=new AbortController();controller.abort();
    await expect(classify(snapshot,controller.signal)).rejects.toThrow("Classification unavailable");expect(provider.getCredential).not.toHaveBeenCalled();
  });
  it("applies a server-owned rate cap independent of caller IDs",async()=>{
    const{classify,fetcher}=setup({maxCallsPerHour:1});await classify(snapshot,new AbortController().signal);
    await expect(classify(snapshot,new AbortController().signal)).rejects.toThrow("Classification unavailable");expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
