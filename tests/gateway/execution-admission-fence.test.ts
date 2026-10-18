import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { createDispatcher, type SpawnFn } from "../../packages/gateway/src/dispatcher.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { SharedChatExecutionCoordinator, type SharedChatExecutionCoordinatorOptions } from "../../packages/gateway/src/chat/shared-execution-coordinator.js";
import { createExecutionAdmissionFence } from "../../packages/gateway/src/execution-admission-fence.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { type: "personal" as const, ownerId: "owner_fence" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
function catalog() {
  return CanonicalProviderCatalogSchema.parse({ revision: "catalog_fence", drivers: [{kind:"codex",displayName:"Codex",adapterVersion:"1.0.0",capabilityClass:"coding_agent"}],
    instances:[{id:"codex_default",driverKind:"codex",displayName:"Codex",availability:"available",workspaceRequirement:"project_optional",catalogRevision:"catalog_fence",
      models:[{id:"gpt-5.6-sol",displayName:"Model",availability:"available",capabilities:["reasoning","tools"],supportsVision:false,supportsToolUse:true}],
      options:[],skills:[],commands:[],setupActions:[],supports:{rootChat:true,resume:true,cancellation:true,steering:"same_run",attachments:["file","image","structured_ref"],tools:[],approvals:true,userInput:true,worktrees:"optional",resources:["file","folder","project","task","app","terminal_session"],interactionModes:["default"],permissionModes:["supervised"]}}] });
}
async function canonicalFixture(fence = createExecutionAdmissionFence(), onCatalog?: () => void) {
  const pg = await createTestPGlite(); const repository = new ChatRepository(pg.dialect); await repository.bootstrap();
  cleanups.push(() => repository.kysely.destroy());
  await repository.create(owner,{id:"chat_fenced",clientRequestId:"req_create_fenced",title:"Fenced"});
  const start = vi.fn(async function* () { yield {type:"run.completed" as const,outcome:"completed" as const}; });
  const provider: CanonicalChatProviderAdapter = {driverKind:"codex",stateSchemaVersion:1,parseState:value=>value,serializeState:value=>value,start};
  let shared!: SharedChatExecutionCoordinatorOptions;
  const orchestrator = new CanonicalChatOrchestrator({repository,executionAdmissionFence:fence,
    catalog:{getCatalog:async()=>{onCatalog?.();return catalog();}},adapters:new CanonicalChatProviderRegistry([provider]),
    sharedExecutionCoordinatorFactory:options=>{shared=options;return new SharedChatExecutionCoordinator(options);}});
  cleanups.push(() => orchestrator.close());
  const admit = () => orchestrator.admitTurn(principal,owner,"chat_fenced",{clientRequestId:"req_turn_fenced",baseRevision:0,parts:[{type:"text",text:"Hello"}],selection:{instanceId:"codex_default",model:"gpt-5.6-sol"},interactionMode:"default",permissionMode:"supervised"});
  return {fence,repository,orchestrator,start,provider,admit,shared};
}

describe("shared execution admission fence",()=>{
  it("blocks legacy dispatch and batch before queueing or starting work, then admits after release",async()=>{
    const homePath=await mkdtemp(join(tmpdir(),"matrix-dispatch-fence-"));
    cleanups.push(()=>rm(homePath,{recursive:true,force:true}));
    await mkdir(join(homePath,"system")); await writeFile(join(homePath,"system/config.json"),JSON.stringify({kernel:{anthropicApiKey:"owner-test-key"}}));
    const fence=createExecutionAdmissionFence(); const spawn=vi.fn<SpawnFn>(async function*(){yield {type:"result",data:{sessionId:"fence",cost:0,turns:1}};});
    const dispatcher=createDispatcher({homePath,spawnFn:spawn,executionAdmissionFence:fence});
    cleanups.push(async()=>{dispatcher.db.$client.close();});
    const release=fence.tryAcquire()!;
    await expect(dispatcher.dispatch("Hello",undefined,()=>{})).rejects.toThrow("temporarily unavailable");
    await expect(dispatcher.dispatchBatch([{taskId:"task_fence",message:"Hello",onEvent:()=>{}}])).rejects.toThrow("temporarily unavailable");
    expect(dispatcher.queueLength).toBe(0);expect(dispatcher.activeCount).toBe(0);expect(spawn).not.toHaveBeenCalled();
    release();await dispatcher.dispatch("Hello",undefined,()=>{});expect(spawn).toHaveBeenCalledOnce();
  });
  it("rejects canonical admission before creating records while the fence is held",async()=>{
    const f=await canonicalFixture();const admit=vi.spyOn(f.repository,"admitTurn");const release=f.fence.tryAcquire()!;
    await expect(f.admit()).rejects.toMatchObject({status:503});expect(admit).not.toHaveBeenCalled();expect(f.start).not.toHaveBeenCalled();
    release();await f.admit();await f.orchestrator.drain();expect(f.start).toHaveBeenCalledOnce();
  });
  it("rechecks capacity after asynchronous canonical admission and fails the accepted run safely",async()=>{
    const fence=createExecutionAdmissionFence();const f=await canonicalFixture(fence);
    const originalAdmit=f.repository.admitTurn.bind(f.repository);
    vi.spyOn(f.repository,"admitTurn").mockImplementation(async(...args)=>{const result=await originalAdmit(...args);fence.tryAcquire();return result;});
    await expect(f.admit()).rejects.toMatchObject({status:503});
    expect(f.shared.atCapacity(owner)).toBe(true);expect(f.start).not.toHaveBeenCalled();
    const exported=await f.repository.exportChat(owner,"chat_fenced");expect(exported?.runs[0]?.status).toBe("failed");
  });
  it("blocks the final shared canonical startDispatch path under the same fence",async()=>{
    const f=await canonicalFixture();const admitted=await f.admit();await f.orchestrator.drain();f.start.mockClear();
    f.fence.tryAcquire();expect(()=>f.shared.startDispatch({owner,message:admitted.message,run:admitted.run,adapter:f.provider,scopeId:"scope_fenced",onComplete:async()=>{}})).toThrow("temporarily unavailable");
    expect(f.start).not.toHaveBeenCalled();expect(f.orchestrator.activeCount).toBe(0);
  });
});
