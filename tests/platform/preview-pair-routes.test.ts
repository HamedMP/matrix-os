import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createPreviewPairRoutes } from "../../packages/platform/src/preview-pair/routes.js";
import { previewPairManifestFixture, PAIR_NOW } from "./preview-pair-test-support.js";

const manifest = previewPairManifestFixture(), pairId = manifest.pairId, secret = "x".repeat(32);
function start() { return { repository: manifest.repository, pairId, pr: manifest.pr, sourceSha: manifest.sourceSha,
  controllerRunId: 42, candidate: { sourceSha: manifest.sourceSha, hostBundleVersion: manifest.members.owner.installedVersion,
    hostBundleSha256: "c".repeat(64), browserOrigin: manifest.browserOrigin, apiOrigin: manifest.apiOrigin,
    desktopArtifacts: manifest.desktopArtifacts, identityIssuer: manifest.identityIssuer, platformSource: manifest.platformSource } }; }
function setup(enabled = true) {
  const service = { start: vi.fn(async () => ({ pairId, state: "preparing" })), action: vi.fn(async () => ({ pairId })),
    reconcile: vi.fn(async () => ({ checked: 0 })), report: vi.fn(async () => ({ pairId, state: "ready" })),
    manifest: vi.fn(async () => manifest), list: vi.fn(async () => ({ items: [], cursor: null })) };
  const reader = { kind: "control" as const, actorId: "user_requester", expiresAt: PAIR_NOW + 60_000 };
  const app = createPreviewPairRoutes({ enabled, operatorSecret: secret, service,
    authenticateReader: async request => request.headers.get("authorization") === "Bearer verified-reader" ? reader : null,
    now: () => PAIR_NOW });
  const post = (path: string, body: unknown, token = secret) => app.request(path, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { app, service, reader, post };
}
describe("pair HTTP contracts enforce auth and limits before service effects", () => {
  it("does not intercept unrelated routes when mounted into the Platform parent", async () => {
    const { app } = setup(false);
    const parent = new Hono().route("/", app).get("/unrelated", c => c.json({ ok: true }));
    expect((await parent.request("/unrelated")).status).toBe(200);
  });
  it("terminates unknown reserved paths before the parent owner-runtime fallback", async () => {
    const { app } = setup();
    const parent = new Hono().route("/", app).all("*", c => c.json({ ownerRuntimeFallback: true }, 202));
    const response = await parent.request(`/api/preview-pairs/${pairId}/unknown`, { headers: { Authorization: "Bearer verified-reader" } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("ownerRuntimeFallback");
  });
  it("returns explicit unavailable when the feature is off", async () => {
    const { post, service } = setup(false);
    expect((await post("/vps/preview-pairs", start())).status).toBe(503);
    expect(service.start).not.toHaveBeenCalled();
  });
  it("requires the real operator bearer for mutations", async () => {
    const { post, service } = setup();
    expect((await post("/vps/preview-pairs", start(), "wrong")).status).toBe(401);
    expect(service.start).not.toHaveBeenCalled();
  });
  it("accepts a strict start and never derives owners from body or identity headers", async () => {
    const { post, service } = setup();
    expect((await post("/vps/preview-pairs", start())).status).toBe(202);
    expect(service.start).toHaveBeenCalledWith(start());
    expect((await post("/vps/preview-pairs", { ...start(), requesterId: "user_other", ownerId: "user_customer" })).status).toBe(400);
    expect(service.start).toHaveBeenCalledTimes(1);
  });
  it("limits the actual body before JSON buffering despite a false Content-Length", async () => {
    const { app, service } = setup();
    const response = await app.request("/vps/preview-pairs", { method: "POST", headers: {
      Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Content-Length": "1" },
      body: JSON.stringify({ padding: "x".repeat(20_000) }) });
    expect(response.status).toBe(413);
    expect(service.start).not.toHaveBeenCalled();
  });
  it.each([{ type: "stop", generation: 0, revision: 1 }, { type: "exec", generation: 1, revision: 1, command: "arbitrary" },
    { type: "stop", generation: 1, revision: 1, machineId: "unrelated" }])("rejects invalid or unscoped action %j", async body => {
    const { post, service } = setup();
    expect((await post(`/vps/preview-pairs/${pairId}/actions`, body)).status).toBe(400);
    expect(service.action).not.toHaveBeenCalled();
  });
  it("validates UUID parameters and bounded reconcile pages", async () => {
    const { post, service } = setup();
    expect((await post("/vps/preview-pairs/not-a-uuid/actions", { type: "stop", generation: 1, revision: 1 })).status).toBe(400);
    expect((await post("/vps/preview-pairs/reconcile", { limit: 17 })).status).toBe(400);
    expect(service.action).not.toHaveBeenCalled(); expect(service.reconcile).not.toHaveBeenCalled();
  });
  it("requires configured real-session authentication for report and manifest reads", async () => {
    const { app, service } = setup();
    expect((await app.request(`/api/preview-pairs/${pairId}`, { headers: { "x-user-id": "user_requester" } })).status).toBe(401);
    expect(service.report).not.toHaveBeenCalled();
  });
  it("passes only the verifier principal to report/manifest reads and disables caches", async () => {
    const { app, service, reader } = setup();
    const response = await app.request(`/api/preview-pairs/${pairId}/manifest`, { headers: { Authorization: "Bearer verified-reader", "x-user-id": "user_other" } });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(service.manifest).toHaveBeenCalledWith(pairId, reader);
  });
  it.each(["limit=17", "cursor=invalid", "limit=1&limit=2", "ownerId=user_other"])("rejects malformed list query %s", async query => {
    const { app, service } = setup();
    const response = await app.request(`/api/preview-pairs?${query}`, { headers: { Authorization: "Bearer verified-reader" } });
    expect(response.status).toBe(400); expect(service.list).not.toHaveBeenCalled();
  });
  it("logs only error class and returns a fixed safe response for unexpected service failures", async () => {
    const { post, service } = setup();
    service.start.mockRejectedValueOnce(new Error("provider postgres credential /private/path"));
    const response = await post("/vps/preview-pairs", start());
    expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/postgres|credential|private\/path/);
  });
});
