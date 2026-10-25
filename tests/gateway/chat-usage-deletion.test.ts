import { describe, expect, it, vi } from "vitest";
import { withChatUsageDeletion } from "../../packages/gateway/src/chat-usage-deletion.js";
describe("Chat analytics actual deletion hook",()=>{
  it("deletes analytics only after authenticated Chat deletion succeeds",async()=>{
    const order:string[]=[];const service={delete:vi.fn(async()=>{order.push("chat");return{deleted:true};})};
    const classifier={deleteChat:vi.fn(async()=>{order.push("analytics");})};
    const wrapped=withChatUsageDeletion(service as never,classifier as never);
    expect(await wrapped.delete({type:"personal",ownerId:"owner_one"},"chat_one","request_one")).toEqual({deleted:true});
    expect(order).toEqual(["chat","analytics"]);expect(classifier.deleteChat).toHaveBeenCalledWith("owner_one","chat_one");
  });
  it("does not cancel anything after a refused or failed deletion",async()=>{
    const service={delete:vi.fn().mockRejectedValue(new Error("denied"))};const classifier={deleteChat:vi.fn()};
    await expect(withChatUsageDeletion(service as never,classifier as never).delete({type:"personal",ownerId:"owner_one"},"other_chat","request_one")).rejects.toThrow("denied");expect(classifier.deleteChat).not.toHaveBeenCalled();
  });
  it("keeps organization deletion outside personal analytics",async()=>{
    const service={delete:vi.fn().mockResolvedValue({deleted:true})};const classifier={deleteChat:vi.fn()};
    await withChatUsageDeletion(service as never,classifier as never).delete({type:"org",orgId:"org_one"} as never,"chat_one","request_one");expect(classifier.deleteChat).not.toHaveBeenCalled();
  });
});
