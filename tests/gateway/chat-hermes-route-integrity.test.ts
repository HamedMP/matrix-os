import { describe, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { fakeGateway, baseInput } from "./hermes-test-gateway.js";

describe("Hermes Codex subscription route integrity", () => {
  it.each(["start", "resume"] as const)("fails closed before prompt submission when %s resolves to Anthropic", async method => {
    const gateway = fakeGateway({ effectiveRoute: {provider: "anthropic",model: "claude-fable-5"} });
    const adapter = createHermesChatProviderAdapter({homePath:"/home/matrix/home",spawnFn:gateway.spawnFn,requestTimeoutMs:100});
    const events: any[]=[];
    const iterator = method === "resume" ? adapter.resume!({...baseInput,resumeState:{sessionId:"durable_session"}})
      : adapter.start(baseInput);
    const finished=(async()=>{for await(const event of iterator) events.push(event);})();
    await vi.waitFor(()=>expect(gateway.requests.some(r=>r.method==="config.set" && r.params.key==="yolo")).toBe(true));
    gateway.event("message.complete",{text:"Anthropic rejected your API key",status:"error"});
    await finished;
    expect(gateway.requests.some(r=>r.method==="prompt.submit")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({type:"run.completed",outcome:"failed"}));
    expect(JSON.stringify(events)).not.toContain("rejected your API key");
  });
  it("settles a pre-prompt transport failure without waiting for native route metadata", async () => {
    const gateway=fakeGateway({omitRouteInfo:true});
    const adapter=createHermesChatProviderAdapter({homePath:"/home/matrix/home",spawnFn:gateway.spawnFn,requestTimeoutMs:1000});
    let done=false;
    const finished=(async()=>{for await(const _event of adapter.start(baseInput)){} done=true;})();
    await vi.waitFor(()=>expect(gateway.requests.some(r=>r.method==="config.set" && r.params.key==="yolo")).toBe(true));
    gateway.sendRaw("invalid protocol\n");
    await vi.waitFor(()=>expect(done).toBe(true),{timeout:200});
    await finished;
    expect(gateway.requests.some(r=>r.method==="prompt.submit")).toBe(false);
  });
  it("settles a native build failure before submitting a prompt", async () => {
    const gateway = fakeGateway({ omitRouteInfo: true });
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn, requestTimeoutMs: 1000 });
    const events: any[] = [];
    let done = false;
    const finished = (async () => { for await (const event of adapter.start(baseInput)) events.push(event); done = true; })();
    await vi.waitFor(() => expect(gateway.requests.some(r => r.method === "config.set" && r.params.key === "yolo")).toBe(true));
    gateway.event("error", { message: "Anthropic rejected your API key" });
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 200 });
    await finished;
    expect(gateway.requests.some(r => r.method === "prompt.submit")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("rejected your API key");
  });
});
