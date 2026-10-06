import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppReadJobRunner } from "../../../packages/gateway/src/app-read-jobs/runner.js";
import { ReadJobConfigSchema } from "../../../packages/gateway/src/app-read-jobs/types.js";
const job = ReadJobConfigSchema.parse({jobs:[{id:"brief",app:"developer-briefing",recipe:"developer-briefing-v1",enabled:true,intervalMs:900000,sources:[{id:"issues",service:"linear",connectionId:"account",label:"Work",params:{teamId:"team"}}]}]}).jobs[0]!;
afterEach(() => vi.useRealTimers());
function setup(read = vi.fn(async () => ({data:{data:{issues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}})), onSummary?: (input: any, signal: AbortSignal) => Promise<any>) {
  const store = {prepare:vi.fn(),claim:vi.fn(async () => ({generation:1,startedAt:new Date().toISOString()})),finish:vi.fn(async () => true),markSummaryAttempt:vi.fn(async () => true),status:vi.fn(async () => ({paused:false,summaryAt:null,summaryHash:null})),snapshots:vi.fn(async () => []),setPaused:vi.fn()};
  const authorize = vi.fn(async () => {});
  let config: unknown = {jobs:[job]};
  const updateConfig=vi.fn(async (_app:string,_id:string,settings:unknown)=>{config={jobs:[{...job,...settings as any}]};});
  const runner = createAppReadJobRunner({updateConfig,ownerId:"owner",store:store as any,loadConfig:async () => config,read:read as any,authorize,onSummary});
  return {runner,store,authorize,read,updateConfig,setConfig:(value:unknown) => {config=value;}};
}
describe("app read job lifecycle", () => {
  it("writes a durable attempt before AI starts and refuses inference if the lease lost",async()=>{
    let store: ReturnType<typeof setup>["store"];
    const onSummary=vi.fn(async()=>{
      expect(store.markSummaryAttempt).toHaveBeenCalledOnce();
      throw new Error("failed model");
    });
    const first=setup(undefined,onSummary);store=first.store;
    first.setConfig({jobs:[{...job,summary:{enabled:true}}]});
    await first.runner.run("owner",job.app,job.id);await first.runner.idle();
    expect(onSummary).toHaveBeenCalledOnce();
    const second=setup(undefined,onSummary);
    second.setConfig({jobs:[{...job,summary:{enabled:true}}]});
    second.store.markSummaryAttempt.mockResolvedValueOnce(false);
    onSummary.mockClear();
    await second.runner.run("owner",job.app,job.id);await second.runner.idle();
    expect(onSummary).not.toHaveBeenCalled();
  });
  it("starts due collection without a renderer and schedules again through the same fenced runner", async () => {
    vi.useFakeTimers();
    const {runner,store,read}=setup();
    runner.start(); await runner.idle();
    expect(read).toHaveBeenCalledOnce();
    expect(store.claim).toHaveBeenCalledWith(job,false);
    await vi.advanceTimersByTimeAsync(15000);await runner.idle();
    expect(read).toHaveBeenCalledTimes(2);
    await runner.stop();
  });
  it("rechecks exact grants before commit and fences revocation rather than publishing data", async () => {
    const {runner,store,authorize}=setup();
    authorize.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("revoked"));
    expect(await runner.run("owner",job.app,job.id)).toEqual({status:"accepted"});
    await runner.idle();
    expect(store.finish).toHaveBeenCalledWith(job,expect.anything(),expect.objectContaining({status:"aborted",snapshots:[]}));
  });
  it("fails closed for a foreign caller or changed config and does not close the injected store", async () => {
    const {runner,store,setConfig}=setup();
    await expect(runner.run("foreign",job.app,job.id)).rejects.toMatchObject({code:"denied"});
    setConfig({jobs:[{...job,enabled:false}]});
    expect(await runner.run("owner",job.app,job.id)).toEqual({status:"disabled"});
    expect(store.claim).not.toHaveBeenCalled();
    await runner.stop();
  });
  it("aborts and drains a cooperative in-flight read before stop resolves", async () => {
    let aborted=false;
    const read=vi.fn((_:unknown,signal:AbortSignal) => new Promise((_,reject) => signal.addEventListener("abort",() => {aborted=true;reject(new DOMException("Aborted","AbortError"));},{once:true})));
    const {runner}=setup(read as any);
    await runner.run("owner",job.app,job.id);
    await new Promise(resolve => setTimeout(resolve,0));
    await runner.stop();
    expect(aborted).toBe(true);
  });
  it("authorizes every candidate source before persisting configuration without writing grants",async()=>{
    const {runner,authorize,updateConfig}=setup();
    const sources=[{...job.sources[0]!,params:{teamId:"other-team"}}];
    authorize.mockRejectedValueOnce(Object.assign(new Error("Private denied detail"),{code:"denied"}));
    await expect(runner.configure("owner",job.app,job.id,{sources})).rejects.toMatchObject({code:"denied"});
    expect(updateConfig).not.toHaveBeenCalled();
    authorize.mockResolvedValueOnce(undefined);
    expect(await runner.configure("owner",job.app,job.id,{sources})).toMatchObject({configuration:{sources}});
    expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ownerId:"owner",service:"linear",action:"list_issues",params:{teamId:"other-team"}}),expect.any(AbortSignal));
    expect(updateConfig).toHaveBeenCalledOnce();
  });

  it("drains a pending database claim and never starts work after shutdown",async()=>{
    const {runner,store,read}=setup();
    let release:(value:{generation:number;startedAt:string})=>void;
    store.claim.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=runner.run("owner",job.app,job.id);
    await new Promise(resolve=>setTimeout(resolve,0));
    let stopped=false;
    const stop=runner.stop().then(()=>{stopped=true;});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(stopped).toBe(false);
    release!({generation:1,startedAt:new Date().toISOString()});
    expect(await pending).toEqual({status:"disabled"});
    await stop;
    expect(read).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(job,expect.anything(),{status:"aborted",snapshots:[]});
  });

});
