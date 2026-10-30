import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {createSeededPreviewPair} from "./preview-pair-seeded-postgres.js";
import {PAIR_NOW,previewPairManifestFixture} from "./preview-pair-test-support.js";
import {claimPreviewPair,requestPreviewPairStop} from "../../packages/platform/src/preview-pair/lifecycle.js";
import {createCustomerVpsContext} from "../../packages/platform/src/customer-vps-context.js";
import {createMockCustomerVpsSystemStore} from "./customer-vps-fixtures.js";
import {createTestConfig} from "./customer-vps-service-test-helper.js";
import * as provision from "../../packages/platform/src/preview-pair/provisioning.js";
const secret="isolated-preview-"+"p".repeat(40),apiOrigin=previewPairManifestFixture().apiOrigin;
const overrides={platformSecret:secret,platformRegisterUrl:`${apiOrigin}/vps/register`,fundedAiRelayUrl:apiOrigin,r2PrefixRoot:"preview-pair-test"};
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("narrow Preview-pair durable provider dispatch",()=>{
 let f:Awaited<ReturnType<typeof createSeededPreviewPair>>;
 beforeEach(async()=>{f=await createSeededPreviewPair(overrides);},30_000);afterEach(async()=>{await f?.destroy();});
 async function setup(verify=true,contextOverride={}){
  const context=createCustomerVpsContext({db:f.db,config:createTestConfig({...overrides,...contextOverride}),hetzner:f.hetzner,systemStore:createMockCustomerVpsSystemStore(),now:()=>new Date(PAIR_NOW)});
  const claim=await claimPreviewPair(f.db,f.pair.pair_id,1,1,PAIR_NOW);
  const members=await f.db.executor.selectFrom("preview_pair_members").selectAll().execute();
  const input={pairId:f.pair.pair_id,generation:1,candidate:f.candidate,members:members.map(m=>({role:m.role,machineId:m.machine_id,jobId:m.job_id,actorId:m.actor_id,handle:m.handle}))};
  return {claim,input,activate:(provision as any).createPreviewPairProvisioning({db:f.db,controlSecret:"control-"+"c".repeat(40),context:async()=>context,verifyAuthority:async()=>verify,mirror:async()=>undefined,now:()=>PAIR_NOW})};
 }
 it("dispatches existing durable jobs only after isolated authority and both projections are verified",async()=>{
  const {claim,input,activate}=await setup();await activate(input,claim,new AbortController().signal);
  expect(f.hetzner.createServer).toHaveBeenCalledTimes(2);
  for(const call of f.hetzner.createServer.mock.calls)expect(call[0].userData).toContain(apiOrigin);
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
