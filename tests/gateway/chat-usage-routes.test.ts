import { describe, expect, it, vi } from "vitest";
import { createChatUsageRoutes } from "../../packages/gateway/src/chat-usage-routes.js";

function setup(principal: {userId:string;source:string}|null = {userId:"owner_one",source:"jwt"}) {
  const store = { getOwnerPolicy: vi.fn().mockResolvedValue(null), configureOwner: vi.fn().mockResolvedValue(undefined),
    aggregate: vi.fn().mockResolvedValue([{taskFamily:"coding",generations:2,classified:1,costUsd:null}]) };
  const classifier = { cancelOwner: vi.fn().mockResolvedValue(undefined), deleteOwner: vi.fn().mockResolvedValue(undefined) };
  const runtime = {store,classifier,modelId:"@cf/openai/gpt-oss-20b"};
  const app=createChatUsageRoutes({ownerId:"owner_one",getPrincipal:()=>principal as never,getRuntime:()=>runtime as never,
    now:()=>new Date("2026-10-25T14:00:00.000Z")});
  return {app,store,classifier};
}
const policy=(body:unknown)=>({method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
describe("owner Chat usage API",()=>{
  it.each([null,{userId:"outsider",source:"jwt"},{userId:"owner_one",source:"dev-default"},{userId:"owner_one",source:"configured-container"}])("denies absent, foreign and implicit owner principals %#",async principal=>{
    const {app,store}=setup(principal);
    expect((await app.request("/api/chat-usage/policy")).status).toBe(principal?403:401);
    expect((await app.request("/api/chat-usage/policy",policy({enabled:true,sampleRateBps:1000,disclosureVersion:"chat-usage-v1"}))).status).toBe(principal?403:401);
    expect(store.configureOwner).not.toHaveBeenCalled();
  });
  it("reports unavailable runtime without pretending analytics is empty",async()=>{
    const app=createChatUsageRoutes({ownerId:"owner_one",getPrincipal:()=>({userId:"owner_one",source:"jwt"}),getRuntime:()=>undefined});
    expect((await app.request("/api/chat-usage/summary")).status).toBe(503);
  });
  it("shows persistent policy and actual configured classification recipient",async()=>{
    const {app,store}=setup(); store.getOwnerPolicy.mockResolvedValue({enabled:true,sampleRateBps:1000} as never);
    const response=await app.request("/api/chat-usage/policy");
    expect(await response.json()).toEqual({enabled:true,sampleRateBps:1000,modelId:"@cf/openai/gpt-oss-20b",recipient:"Cloudflare Workers AI",disclosureVersion:"chat-usage-v1",retentionDays:30});
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("requires explicit disclosure acknowledgement and rejects caller identity or arbitrary metadata",async()=>{
    const {app,store}=setup();
    for(const body of [{enabled:true,sampleRateBps:1000},{enabled:true,sampleRateBps:1000,disclosureVersion:"chat-usage-v0"},
      {enabled:true,sampleRateBps:1000,disclosureVersion:"chat-usage-v1",ownerId:"outsider"},
      {enabled:true,sampleRateBps:10001,disclosureVersion:"chat-usage-v1"}]) expect((await app.request("/api/chat-usage/policy",policy(body))).status).toBe(400);
    expect(store.configureOwner).not.toHaveBeenCalled();
    expect((await app.request("/api/chat-usage/policy",policy({enabled:true,sampleRateBps:1000,disclosureVersion:"chat-usage-v1"}))).status).toBe(200);
    expect(store.configureOwner).toHaveBeenCalledWith("owner_one",{enabled:true,sampleRateBps:1000});
  });
  it("disables admission before cancelling work and preserves retained facts",async()=>{
    const {app,store,classifier}=setup(); const sequence:string[]=[];
    store.configureOwner.mockImplementation(async()=>{sequence.push("disabled");}); classifier.cancelOwner.mockImplementation(async()=>{sequence.push("cancelled");});
    expect((await app.request("/api/chat-usage/policy",policy({enabled:false,sampleRateBps:1000}))).status).toBe(200);
    expect(sequence).toEqual(["disabled","cancelled"]);expect(classifier.deleteOwner).not.toHaveBeenCalled();
  });
  it("bounds summaries and retains unknown costs and sample coverage",async()=>{
    const {app,store}=setup();
    const response=await app.request("/api/chat-usage/summary?groupBy=taskFamily,modelId&limit=50");
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({buckets:[{generations:2,classified:1,costUsd:null}],classificationIsEstimate:true});
    expect(store.aggregate).toHaveBeenCalledWith({ownerId:"owner_one",from:"2026-10-18T14:00:00.000Z",to:"2026-10-25T14:00:00.000Z",groupBy:["taskFamily","modelId"],includeUnclassified:true,limit:50});
    for(const query of ["groupBy=prompt","groupBy=taskFamily,taskFamily","ownerId=outsider","limit=201","from=bad","from=2026-01-01T00:00:00Z","from=2026-10-18T16:00:00%2B02:00"]) expect((await app.request("/api/chat-usage/summary?"+query)).status).toBe(400);
  });
  it("bounds mutation bodies including DELETE and safely handles server errors",async()=>{
    const {app,store,classifier}=setup();
    expect((await app.request("/api/chat-usage/data",{method:"DELETE",body:"x".repeat(5000)})).status).toBe(413);
    expect(classifier.deleteOwner).not.toHaveBeenCalled();
    expect((await app.request("/api/chat-usage/data",{method:"DELETE"})).status).toBe(200);
    expect(classifier.deleteOwner).toHaveBeenCalledWith("owner_one");
    store.aggregate.mockRejectedValue(new Error("PRIVATE postgres credentials"));
    const failed=await app.request("/api/chat-usage/summary");expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("postgres");
  });
});
