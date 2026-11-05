import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { stubOrchestrator, JWT_SECRET } from "./proxy-routing-test-utils.js";
import { PAIR_NOW, previewPairManifestFixture } from "./preview-pair-test-support.js";

describe("pair endpoints are registered before owner routing without intercepting other APIs", () => {
  let fixture: Awaited<ReturnType<typeof createTestPlatformDb>>;
  beforeAll(async () => { fixture = await createTestPlatformDb(); });
  afterAll(async () => { await destroyTestPlatformDb(fixture?.db); });
  function setup(enabled: boolean) {
    const manifest = previewPairManifestFixture();
    const service = { report: vi.fn(async () => ({ pairId: manifest.pairId })), manifest: vi.fn(async () => manifest),
      list: vi.fn(async () => ({ items: [] })), start: vi.fn(async () => ({})), action: vi.fn(async () => ({})), reconcile: vi.fn(async () => ({})) };
    const app = createApp({ db: fixture.db, orchestrator: stubOrchestrator(), platformSecret: JWT_SECRET,
      clerkAuth: createClerkAuth({ verifyToken: async () => { throw new Error("No fixture session"); } }),
      env: { PLATFORM_JWT_SECRET: JWT_SECRET, MATRIX_PREVIEW_PAIR_ENABLED: enabled ? "true" : "false",
        MATRIX_API_ORIGIN: "https://api.matrix-os.com" },
      previewPairs: { enabled: true, operatorSecret: "x".repeat(32), service, now: () => PAIR_NOW,
        authenticateReader: async () => ({ actorId: "user_requester", kind: "control", expiresAt: PAIR_NOW + 60_000 }) } });
    return { app, service, manifest };
  }
  it("provides explicit unavailable for a disabled pair feature while ordinary inventory auth remains intact", async () => {
    const { app, manifest, service } = setup(false);
    expect((await app.request(`https://app.matrix-os.com/api/preview-pairs/${manifest.pairId}`)).status).toBe(503);
    expect((await app.request("https://app.matrix-os.com/api/auth/computers")).status).toBe(401);
    expect((await app.request("https://app.matrix-os.com/health")).status).toBe(200);
    expect(service.report).not.toHaveBeenCalled();
  });
  it("routes a report to the real Platform handler without a private machine or directory fallback", async () => {
    const { app, manifest, service } = setup(true);
    const response = await app.request(`https://app.matrix-os.com/api/preview-pairs/${manifest.pairId}`);
    expect(response.status).toBe(200);
    expect(service.report).toHaveBeenCalledWith(manifest.pairId,
      { actorId: "user_requester", kind: "control", expiresAt: PAIR_NOW + 60_000 });
  });
});
