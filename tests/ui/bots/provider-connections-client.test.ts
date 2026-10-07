import {expect,it,vi} from "vitest";
import {createBotConnectionClient} from "../../../packages/ui/src/chat-agents/bots/provider-connections-client";
const catalog={connections:[{id:"claude_code_tasks",providerId:"anthropic",executionKind:"native_task",availability:"available",models:[{id:"observed-model",displayName:"Observed"}],authorization:{revision:1,enabled:true,background:false},coordinatorFunding:"separate"}]};
it("coalesces discovery and invalidates it after accepted authorization or explicit refresh",async()=>{
 const request=vi.fn().mockResolvedValue(catalog), client=createBotConnectionClient(request);
 await Promise.all([client.connections(),client.connections()]);
 expect(request).toHaveBeenCalledOnce();
 await client.authorizeConnection("claude_code_tasks",{baseRevision:1,enabled:false,background:false});
 await client.connections(); expect(request).toHaveBeenCalledTimes(2);
 client.refreshConnections!(); await client.connections(); expect(request).toHaveBeenCalledTimes(3);
});
it("rejects secret-bearing or unqualified connection DTOs and never sends arbitrary provider IDs",async()=>{
 const request=vi.fn().mockResolvedValue({...catalog,apiKey:"private"}), client=createBotConnectionClient(request);
 await expect(client.connections()).rejects.toThrow("Bot connections are unavailable.");
 request.mockClear();
 await expect(client.authorizeConnection("arbitrary-provider",{baseRevision:1,enabled:true,background:false})).rejects.toThrow();
 expect(request).not.toHaveBeenCalled();
});
