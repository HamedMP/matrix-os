import { describe, expect, it, vi } from "vitest";
import { checkForSystemUpdate, listSystemReleases } from "../../packages/gateway/src/system-update.js";
import { createPrivatePreviewUpdateRoutes } from "../../packages/platform/src/private-preview-update-routes.js";
import { Hono } from "hono";
import type { PlatformDB } from "../../packages/platform/src/db.js";

const base = "https://platform.test/private-preview-updates/pv-2514-affc50d5";

describe("Private Preview system update discovery", () => {
  it("keeps channel and release-list access fenced by the existing controller", async () => {
    const app = createPrivatePreviewUpdateRoutes({ db: {} as PlatformDB, hostBundleRoutes: new Hono(), logRouteError: vi.fn() });
    expect((await app.request("/pv-2514-affc50d5/system-bundles/channels/stable.json")).status).toBe(404);
    expect((await app.request("/pv-2514-affc50d5/system-bundles/releases")).status).toBe(404);
  });

  it.each([base, `${base}/`])("reports owner-managed updates without requesting intentionally blocked channels: %s", async platformUrl => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const installed = { version: "v2026.10.14-pr2514-38579644817-1-9606dbb" };
    const result = await checkForSystemUpdate({ installed, platformUrl, channel: "stable", fetchImpl });
    expect(result).toMatchObject({ installed, latest: null, updateAvailable: false, managedByOwner: true });
    expect(result.error).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    const releases = await listSystemReleases({ platformUrl, channel: "stable", fetchImpl });
    expect(releases).toMatchObject({ releases: [], managedByOwner: true });
    expect(releases.error).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["https://platform.test", "https://platform.test/private-preview-updates/not-a-private-preview", "https://platform.test/unrelated/private-preview-updates/pv-2514-affc50d5"])("preserves normal update checks for %s", async platformUrl => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: "v2026.10.15-1" })));
    const result = await checkForSystemUpdate({ installed: null, platformUrl, channel: "stable", fetchImpl });
    expect(result.latest?.version).toBe("v2026.10.15-1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
