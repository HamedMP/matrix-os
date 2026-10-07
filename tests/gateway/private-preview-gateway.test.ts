import { describe, expect, it, vi } from "vitest";
import {
  describeGatewayCollaborationConfiguration,
  loadGatewayCollaborationConfig,
} from "../../packages/gateway/src/collaboration/config.js";
import {
  fetchHostBundleChannelManifest,
  listSystemReleases,
} from "../../packages/gateway/src/system-update.js";

const privatePreviewBase = "https://app.matrix-os.com/private-preview-updates/pv-1907-3fa91c2e";

function okFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe("Private Preview update base in the gateway", () => {
  it("keeps the per-machine base path for channel manifests", async () => {
    const fetchImpl = okFetch({ version: "v2026.09.28-1" });
    await fetchHostBundleChannelManifest({ platformUrl: privatePreviewBase, channel: "stable", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${privatePreviewBase}/system-bundles/channels/stable.json`,
      expect.anything(),
    );
  });

  it("keeps the per-machine base path for release lists", async () => {
    const fetchImpl = okFetch({ releases: [], generatedAt: "2026-09-28T00:00:00.000Z" });
    await listSystemReleases({ platformUrl: `${privatePreviewBase}/`, channel: "dev", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${privatePreviewBase}/system-bundles/releases?channel=dev`,
      expect.anything(),
    );
  });

  it("leaves origin-only bases unchanged", async () => {
    const fetchImpl = okFetch({ version: "v2026.09.28-1" });
    await fetchHostBundleChannelManifest({ platformUrl: "https://app.matrix-os.com", channel: "canary", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.matrix-os.com/system-bundles/channels/canary.json",
      expect.anything(),
    );
  });
});

describe("Private Preview collaboration", () => {
  const configured = {
    MATRIX_MACHINE_ID: "3fa91c2e-1907-4000-8000-000000001907",
    PLATFORM_INTERNAL_URL: "https://app.matrix-os.com",
    UPGRADE_TOKEN: "u".repeat(64),
    DATABASE_URL: "postgres://matrix@127.0.0.1/matrix",
  };

  it("fails closed when the platform disables collaboration for the machine", () => {
    const env = { ...configured, MATRIX_COLLABORATION_DISABLED: "1" };
    expect(loadGatewayCollaborationConfig(env)).toBeNull();
    expect(describeGatewayCollaborationConfiguration(env)).toEqual({ configured: false, reason: "disabled_for_machine" });
  });

  it("keeps collaboration configured on every other machine", () => {
    expect(loadGatewayCollaborationConfig(configured)).not.toBeNull();
    expect(describeGatewayCollaborationConfiguration({ ...configured, MATRIX_COLLABORATION_DISABLED: "" }))
      .toEqual({ configured: true });
  });
});
