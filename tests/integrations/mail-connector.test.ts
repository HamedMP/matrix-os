import { describe, expect, it, vi } from "vitest";
import { createBoundedMailConnector } from "../../packages/gateway/src/integrations/mail-connector.js";

const identity = { externalUserId: "owner", accountId: "apn_account" };
describe("bounded shared-mail connector", () => {
  it("uses only fixed account-scoped Gmail targets and preserves string history IDs", async () => {
    const fetcher = vi.fn(async () => Response.json({history:[],historyId:"9007199254740999999"}));
    const call = createBoundedMailConnector({projectId:"proj",environment:"production",getAccessToken:async()=>"secret",fetcher});
    await call({...identity, action:"list_history",params:{startHistoryId:"9007199254740999999",maxResults:100}});
    const [url, init] = fetcher.mock.calls[0] as unknown as [string,RequestInit];
    const outer = new URL(url), target = new URL(Buffer.from(outer.pathname.split("/").at(-1)!,"base64url").toString());
    expect(target.origin).toBe("https://gmail.googleapis.com");
    expect(target.searchParams.get("startHistoryId")).toBe("9007199254740999999");
    expect(init.signal).toBeDefined(); expect(init.redirect).toBe("error");
  });
  it("permits archive and undo but never modifies unread or trash", async () => {
    const fetcher = vi.fn(async () => Response.json({id:"message",labelIds:[]}));
    const call=createBoundedMailConnector({projectId:"proj",environment:"production",getAccessToken:async()=>"secret",fetcher});
    await call({...identity,action:"modify_message",params:{messageId:"message",removeLabelIds:["INBOX"]}});
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({removeLabelIds:["INBOX"]});
    for(const labels of [[],["UNREAD"],["TRASH"],["INBOX","INBOX"]]) {
      await expect(call({...identity,action:"modify_message",params:{messageId:"message",removeLabelIds:labels}})).rejects.toThrow();
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("fails closed on an expired history position without claiming message deletion", async () => {
    const call=createBoundedMailConnector({projectId:"proj",environment:"production",getAccessToken:async()=>"secret",fetcher:async()=>new Response("",{status:404})});
    await expect(call({...identity,action:"list_history",params:{startHistoryId:"123"}})).rejects.toMatchObject({code:"history_expired"});
    await expect(call({...identity,action:"get_message",params:{messageId:"gone"}})).rejects.toMatchObject({code:"unavailable"});
  });
  it("bounds streamed response bytes even without a content length", async () => {
    const call=createBoundedMailConnector({projectId:"proj",environment:"production",getAccessToken:async()=>"secret",fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(40*1024));c.close();}}))});
    await expect(call({...identity,action:"get_profile",params:{}})).rejects.toThrow("Email source is unavailable");
  });
  it("denies arbitrary targets, source writes and unbounded pagination before fetching", async () => {
    const fetcher=vi.fn(); const call=createBoundedMailConnector({projectId:"proj",environment:"production",getAccessToken:async()=>"secret",fetcher});
    for(const operation of [{action:"send_email",params:{}},{action:"get_message",params:{messageId:"../profile"}},{action:"search",params:{query:"all",maxResults:501}}]) {
      await expect(call({...identity,...operation})).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
it('reads only metadata for an explicitly oversized message and exposes a typed internal limit',async()=>{
 const fetcher=vi.fn(async()=>Response.json({id:'message',internalDate:'1760000000000',payload:{headers:[]}}));
 const call=createBoundedMailConnector({projectId:'proj',environment:'production',getAccessToken:async()=> 'secret',fetcher});
 await call({...identity,action:'get_message_summary',params:{messageId:'message'}});
 const target=new URL(Buffer.from(new URL(fetcher.mock.calls[0]![0]).pathname.split('/').at(-1)!,'base64url').toString());expect(target.searchParams.get('format')).toBe('metadata');expect(target.searchParams.get('fields')).toContain('internalDate');expect(target.searchParams.get('fields')).not.toContain('body');
 const large=createBoundedMailConnector({projectId:'proj',environment:'production',getAccessToken:async()=> 'secret',fetcher:async()=>new Response('{}',{headers:{'content-length':String(4*1024*1024)}})});await expect(large({...identity,action:'get_message',params:{messageId:'message'}})).rejects.toMatchObject({code:'content_limit'});
});
