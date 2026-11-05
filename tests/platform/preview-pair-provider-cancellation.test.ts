import {expect,it,vi} from "vitest";
import {createHetznerClient} from "../../packages/platform/src/customer-vps-hetzner.js";
import {createTestConfig} from "./customer-vps-service-test-helper.js";
it("a pair activation deadline reaches the real provider request signal",async()=>{
 const controller=new AbortController();let observed:AbortSignal|undefined;
 const fetchImpl=vi.fn(async (_url:unknown,init?:RequestInit)=>{observed=init?.signal??undefined;return new Response(JSON.stringify({action:{id:900,status:"running",command:"create_server"}}));});
 const client=createHetznerClient(createTestConfig(),fetchImpl as typeof fetch,controller.signal);
 await client.getAction(900);expect(observed?.aborted).toBe(false);
 controller.abort();expect(observed?.aborted).toBe(true);
});
