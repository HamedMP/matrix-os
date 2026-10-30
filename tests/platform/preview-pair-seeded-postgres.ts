import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";
import { PAIR_NOW, previewPairConfigurationFixture, previewPairManifestFixture } from "./preview-pair-test-support.js";
import { loadPreviewPairConfig, type EnabledPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { admitPreviewPair } from "../../packages/platform/src/preview-pair/admission.js";
import { preparePreviewPairMember } from "../../packages/platform/src/preview-pair/prepare.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import { createCustomerVpsProvisioner } from "../../packages/platform/src/customer-vps-provision.js";
import { createCustomerVpsProvisioningDispatcher } from "../../packages/platform/src/customer-vps-provisioning-dispatch.js";
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from "./customer-vps-fixtures.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { upsertHostBundleRelease } from "../../packages/platform/src/db.js";

export async function createSeededPreviewPair(overrides: Partial<ReturnType<typeof createTestConfig>> = {}, hostBundleSha256 = "c".repeat(64)) {
  const fixture = await createPreviewPairPostgresFixture();
  try {
    const manifest = previewPairManifestFixture();
    const config = loadPreviewPairConfig(previewPairConfigurationFixture()) as EnabledPreviewPairConfig;
    const candidate = { sourceSha: manifest.sourceSha, hostBundleVersion: manifest.members.owner.installedVersion,
      hostBundleSha256, desktopArtifacts: manifest.desktopArtifacts, browserOrigin: manifest.browserOrigin,
      apiOrigin: manifest.apiOrigin, identityIssuer: manifest.identityIssuer, platformSource: manifest.platformSource };
    await upsertHostBundleRelease(fixture.db, { version: candidate.hostBundleVersion, channel: null,
      sha256: candidate.hostBundleSha256, gitCommit: manifest.sourceSha, sourcePr: manifest.pr,
      buildTime: new Date(PAIR_NOW).toISOString(), bundleKey: "test/bundle.tar.gz", size: 123 });
    const hetzner = createMockHetznerClient();
    const context = createCustomerVpsContext({ db: fixture.db, config: createTestConfig(overrides), hetzner,
      systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW) });
    const provisioner = createCustomerVpsProvisioner(context, createCustomerVpsProvisioningDispatcher(context));
    const prepare = (id: string, generation: number, role: "owner" | "member") => preparePreviewPairMember(context, provisioner, id, generation, role);
    const pair = await admitPreviewPair(fixture.db, config, { pairId: manifest.pairId, pr: manifest.pr,
      requesterId: "user_requester", sourceSha: manifest.sourceSha, candidate }, prepare, PAIR_NOW);
    return { ...fixture, pair, config, candidate, manifest, prepare, hetzner };
  } catch (error: unknown) { await fixture.destroy(); throw error; }
}
