import {expect,it,vi} from "vitest";
import {checkForSystemUpdate,listSystemReleases} from "../../packages/gateway/src/system-update.js";
const platformUrl="https://cp-11111111-g1-api---matrix-platform-preview-test.a.run.app/preview-pair-updates/cp-3022-11111111-1-a";
it("reports a controller-managed pair without probing intentionally absent channels",async()=>{
 const fetchImpl=vi.fn(async()=>new Response("unavailable",{status:404}));
 const update=await checkForSystemUpdate({platformUrl,installed:{version:"candidate"},channel:"dev",fetchImpl:fetchImpl as typeof fetch});
 expect(update).toMatchObject({managedByOwner:true,updateAvailable:false});
 expect(await listSystemReleases({platformUrl,channel:"dev",fetchImpl:fetchImpl as typeof fetch})).toMatchObject({managedByOwner:true,releases:[]});
 expect(fetchImpl).not.toHaveBeenCalled();
});
