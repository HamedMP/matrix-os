import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createApp} from "../../packages/platform/src/main.js";
import {insertUserMachine,upsertHostBundleRelease,updateUserMachine} from "../../packages/platform/src/db.js";
import type {CustomerVpsObjectStore} from "../../packages/platform/src/customer-vps-r2.js";
import {createPreviewPairPostgresFixture} from "./preview-pair-postgres-support.js";
import {previewPairManifestFixture,PAIR_NOW} from "./preview-pair-test-support.js";
import {stubOrchestrator} from "./proxy-routing-test-utils.js";
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("pair host updater uses real public release routing",()=>{
 let fixture:Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
 beforeEach(async()=>{fixture=await createPreviewPairPostgresFixture();},30_000);
 afterEach(async()=>{await fixture?.destroy();});
 it("serves the projected candidate only and reserves the rest of its prefix",async()=>{
  const manifest=previewPairManifestFixture(),member=manifest.members.owner,version=member.installedVersion;
  await upsertHostBundleRelease(fixture.db,{version,channel:null,gitCommit:manifest.sourceSha,sourcePr:manifest.pr,buildTime:new Date(PAIR_NOW).toISOString(),sha256:"c".repeat(64),size:123,bundleKey:"test/candidate.tar.gz"});
  await insertUserMachine(fixture.db,{machineId:member.machineId,clerkUserId:member.actorId,handle:member.handle,runtimeSlot:member.handle,provisioningClass:"preview",status:"running",confirmedBundleVersion:version,targetBundleVersion:version,targetBundleSha256:"c".repeat(64),imageVersion:version,accessClerkUserIds:[],provisionedAt:new Date(PAIR_NOW).toISOString()});
  const store={getObject:vi.fn(),putObject:vi.fn(),getPresignedGetUrl:vi.fn(async()=>"https://bundles.example/signed-test-bundle")} as unknown as CustomerVpsObjectStore;
  const app=createApp({db:fixture.db,orchestrator:stubOrchestrator(),platformSecret:"test-platform-secret",customerVpsObjectStore:store});
  const base=`/preview-pair-updates/${member.handle}/system-bundles`,path=`${base}/releases/${version}.json`;
  const response=await app.request(path);expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({version,gitCommit:manifest.sourceSha,sha256:"c".repeat(64)});
  expect(response.headers.get("cache-control")).toContain("no-store");
  for(const forbidden of [`${base}/channels/dev.json`,`${base}/releases`,`${base}/releases/other.json`,path.replace(member.handle,"alice")])expect((await app.request(forbidden)).status,forbidden).toBe(404);
  await updateUserMachine(fixture.db,member.machineId,{accessClerkUserIds:["user_unrelated"]});expect((await app.request(path)).status).toBe(404);
  await updateUserMachine(fixture.db,member.machineId,{accessClerkUserIds:[],status:"deleted",deletedAt:new Date(PAIR_NOW).toISOString()});expect((await app.request(path)).status).toBe(404);
 });
});
