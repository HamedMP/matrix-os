import {DefinitiveProviderRejectionError} from "../../packages/platform/src/customer-vps-errors.js";
import {createPreviewPairProviderCleanup} from "../../packages/platform/src/preview-pair/cleanup-provider.js";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createSeededPreviewPair} from "./preview-pair-seeded-postgres.js";
import {PAIR_NOW,previewPairManifestFixture} from "./preview-pair-test-support.js";
import {claimPreviewPair,requestPreviewPairStop} from "../../packages/platform/src/preview-pair/lifecycle.js";
import {createCustomerVpsContext} from "../../packages/platform/src/customer-vps-context.js";
import {createMockCustomerVpsSystemStore} from "./customer-vps-fixtures.js";
import {createTestConfig} from "./customer-vps-service-test-helper.js";
import type {HetznerServer} from "../../packages/platform/src/customer-vps-hetzner.js";
import * as provision from "../../packages/platform/src/preview-pair/provisioning.js";
const secret="isolated-preview-"+"p".repeat(40),apiOrigin=previewPairManifestFixture().apiOrigin;
const overrides={platformSecret:secret,platformRegisterUrl:`${apiOrigin}/vps/register`,fundedAiRelayUrl:apiOrigin,r2PrefixRoot:"preview-pair-test"};
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("narrow Preview-pair durable provider dispatch",()=>{
 let f:Awaited<ReturnType<typeof createSeededPreviewPair>>;
 beforeEach(async()=>{f=await createSeededPreviewPair(overrides);},30_000);afterEach(async()=>{await f?.destroy();});
 async function setup(verify=true,contextOverride={}){
  const context=createCustomerVpsContext({db:f.db,config:createTestConfig({...overrides,...contextOverride}),hetzner:{...f.hetzner,withSignal:()=>f.hetzner},systemStore:createMockCustomerVpsSystemStore(),now:()=>new Date(PAIR_NOW)});
  const claim=await claimPreviewPair(f.db,f.pair.pair_id,1,1,PAIR_NOW);
  const members=await f.db.executor.selectFrom("preview_pair_members").selectAll().execute();
  const input={pairId:f.pair.pair_id,generation:1,candidate:f.candidate,members:members.map(m=>({role:m.role,machineId:m.machine_id,jobId:m.job_id,actorId:m.actor_id,handle:m.handle}))};
  return {claim,input,activate:provision.createPreviewPairProvisioning({db:f.db,controlSecret:"control-"+"c".repeat(40),context:async()=>context,verifyAuthority:async()=>verify,mirror:async()=>undefined,now:()=>PAIR_NOW})};
 }
 it("dispatches existing durable jobs only after isolated authority and both projections are verified",async()=>{
  const {claim,input,activate}=await setup();
  await activate(input,claim,new AbortController().signal);
  expect(f.hetzner.createServer).toHaveBeenCalledTimes(1);
  await activate(input,claim,new AbortController().signal);
  expect(f.hetzner.createServer).toHaveBeenCalledTimes(2);
  for(const call of f.hetzner.createServer.mock.calls)expect(call[0].userData).toContain(apiOrigin);
 });
 it("polls a creating server once, releases its exact job, and adopts it on the next pass",async()=>{
  const servers:HetznerServer[]=[];
  vi.mocked(f.hetzner.createServer).mockImplementation(async request=>{
   const server:HetznerServer={id:800+servers.length,status:"running",serverType:"cpx22",publicIPv4:"203.0.113.10",publicIPv6:"2001:db8::/64",labels:request.labels,createActionId:900+servers.length};
   servers.push(server);return server;
  });
  vi.mocked(f.hetzner.listServersByLabel!).mockImplementation(async selector=>servers.filter(server=>selector===`machine_id=${server.labels?.machine_id}`));
  vi.mocked(f.hetzner.getAction).mockResolvedValueOnce({id:900,status:"running",command:"create_server"}).mockResolvedValue({id:900,status:"success",command:"create_server"});
  const {claim,input,activate}=await setup();
  await f.db.executor.updateTable("provisioning_jobs").set({attempts:99}).execute();
  expect(await activate(input,claim,new AbortController().signal)).toBe(false);
  expect(f.hetzner.getAction).toHaveBeenCalledTimes(1);
  const job=await f.db.executor.selectFrom("provisioning_jobs").selectAll().where("machine_id","=",servers[0].labels!.machine_id!).executeTakeFirstOrThrow();
  expect(job.status).toBe("queued");expect(job.lease_expires_at).toBeNull();expect(job.attempts).toBe(99);
  expect(Number(job.provider_create_action_id)).toBe(900);expect(job.activation_step).toBe("creating");
  expect(await activate(input,claim,new AbortController().signal)).toBe(false);
  expect(f.hetzner.createServer).toHaveBeenCalledTimes(1);
  expect((await f.db.executor.selectFrom("provisioning_jobs").select("status").where("job_id","=",job.job_id).executeTakeFirstOrThrow()).status).toBe("completed");
  await activate(input,claim,new AbortController().signal);
  expect(f.hetzner.createServer).toHaveBeenCalledTimes(2);
 });
 it("an aborted create retains its durable intent and cannot blindly POST again",async()=>{
  const controller=new AbortController();let machineId:string|undefined;
  vi.mocked(f.hetzner.createServer).mockImplementation(async request=>{machineId=request.labels?.machine_id;controller.abort();throw new DOMException("Aborted","AbortError");});
  const {claim,input,activate}=await setup();
  await expect(activate(input,claim,controller.signal)).rejects.toThrow();
  const job=await f.db.executor.selectFrom("provisioning_jobs").selectAll().where("machine_id","=",machineId!).executeTakeFirstOrThrow();
  expect(job.status).toBe("queued");expect(job.activation_step).toBe("creating");expect(job.lease_expires_at).toBeNull();
  expect(await activate(input,claim,new AbortController().signal)).toBe(false);
  expect(f.hetzner.createServer).toHaveBeenCalledTimes(1);expect(f.hetzner.deleteServer).not.toHaveBeenCalled();
 });
 it.each(["quota_exceeded","provider_unavailable"] as const)("a definitive %s create rejection does not quarantine an uncreated server",async code=>{
  vi.mocked(f.hetzner.createServer).mockRejectedValue(new DefinitiveProviderRejectionError(400,code,"Provisioning unavailable"));
  f.hetzner.inspectServersByLabel=vi.fn(async()=>({servers:[],complete:true}));
  const {claim,input,activate}=await setup();
  await expect(activate(input,claim,new AbortController().signal)).rejects.toThrow();
  const job=await f.db.executor.selectFrom("provisioning_jobs").selectAll().where("machine_id","=",f.hetzner.createServer.mock.calls[0][0].labels.machine_id).executeTakeFirstOrThrow();
  expect(job.status).toBe("failed");expect(job.activation_step).not.toBe("creating");
  const pending=await requestPreviewPairStop(f.db,f.pair.pair_id,1,claim.revision,PAIR_NOW);
  const cleanupClaim=await claimPreviewPair(f.db,pending.pair_id,1,pending.revision,PAIR_NOW);
  const member=input.members.find(member=>member.jobId===job.job_id)!;
  expect(await createPreviewPairProviderCleanup(f.db,f.hetzner,()=>PAIR_NOW).proveAbsent({...member,pairId:input.pairId,generation:1,providerServerId:null},cleanupClaim)).toMatchObject({creationSettled:true});
 });
 it("does not consume either job when isolation cannot be verified",async()=>{
  const {claim,input,activate}=await setup(false);await expect(activate(input,claim,new AbortController().signal)).rejects.toThrow("unavailable");
  expect(f.hetzner.createServer).not.toHaveBeenCalled();expect((await f.db.executor.selectFrom("provisioning_jobs").select("status").execute()).every(j=>j.status==="queued")).toBe(true);
 });
 it("a stale pair claim cannot create a provider server",async()=>{
  const {claim,input,activate}=await setup();await requestPreviewPairStop(f.db,f.pair.pair_id,1,claim.revision,PAIR_NOW);
  await expect(activate(input,claim,new AbortController().signal)).rejects.toThrow("unavailable");expect(f.hetzner.createServer).not.toHaveBeenCalled();
 });
 it("refuses an ordinary customer authority context",async()=>{
  const {claim,input,activate}=await setup(true,{platformRegisterUrl:"https://api.matrix-os.com/vps/register"});
  await expect(activate(input,claim,new AbortController().signal)).rejects.toThrow("unavailable");expect(f.hetzner.createServer).not.toHaveBeenCalled();
 });
});
