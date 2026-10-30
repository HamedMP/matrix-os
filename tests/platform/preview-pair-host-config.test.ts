import {readFile} from "node:fs/promises";
import {previewPairHostBinding} from "../../packages/platform/src/preview-pair/host-binding.js";
import {expect,it} from "vitest";
import {buildHostConfig,DEFAULT_CLOUD_INIT_TEMPLATE} from "../../packages/platform/src/customer-vps-host-config.js";
import {renderCloudInitTemplate} from "../../packages/platform/src/customer-vps-cloud-init.js";
import {createTestConfig} from "./customer-vps-service-test-helper.js";
import {previewPairManifestFixture} from "./preview-pair-test-support.js";
it("boots a pair against its verified browser/API and pins its host updater",async()=>{
 const manifest=previewPairManifestFixture(),member=manifest.members.owner;
 const value=buildHostConfig(createTestConfig({platformRegisterUrl:`${manifest.apiOrigin}/vps/register`}),
  {clerkUserId:member.actorId,handle:member.handle,runtimeSlot:member.runtimeSlot,provisioningClass:"preview"},member.machineId,
  "test-registration-token","2099-01-01T00:00:00.000Z","test-postgres-password",{imageVersion:member.installedVersion,hostBundleUrl:"https://bundles.example/bundle.tar.gz"},1,{browserOrigin:manifest.browserOrigin});
 for(const template of [DEFAULT_CLOUD_INIT_TEMPLATE,await readFile("distro/customer-vps/cloud-init.yaml","utf8")]){
 const rendered=renderCloudInitTemplate(template,value);
 expect(rendered).toContain(`MATRIX_UPDATE_MANIFEST_BASE_URL=${manifest.apiOrigin}/preview-pair-updates/${member.handle}`);
 expect(rendered).toContain(`COLLABORATION_RELAY_ORIGIN=${manifest.browserOrigin}`);
 expect(rendered).toContain(`MATRIX_COLLABORATION_CLIENT_ORIGINS=${manifest.browserOrigin}`);
 expect(rendered).not.toContain("MATRIX_COLLABORATION_DISABLED=1");
 }
});

it.each([undefined,"https://app.matrix-os.com","https://cp-11111111-g2-ui---matrix-platform-preview-test.a.run.app"])("rejects missing or mismatched internal browser binding: %s",browser=>{
 const manifest=previewPairManifestFixture(),member=manifest.members.owner;
 expect(()=>previewPairHostBinding(member.handle,member.runtimeSlot,manifest.apiOrigin,browser)).toThrow();
});
