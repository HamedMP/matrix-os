import { generateKeyPairSync, sign } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { canonicalJson } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createCollaborationCutoverRoutes } from "../../packages/gateway/src/collaboration/cutover-route.js";

const NOW = new Date("2026-09-21T14:05:00.000Z");
const path = "/internal/collaboration/cutover/10000000-0000-4000-8000-000000000001/inventory";
const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const baseCommand = {
  version: 1 as const,
  scopeId: "10000000-0000-4000-8000-000000000001",
  ownerId: "user_cutover_owner",
  organizationId: "org_cutover",
  runtimeId: "vps:10000000-0000-4000-8000-000000000099",
  expectedSourceGeneration: 1,
  targetGeneration: 2,
  idempotencyKey: "cutover-transport-test",
  phase: "inventory" as const,
  method: "POST" as const,
  path,
  nonce: "50000000-0000-4000-8000-000000000001",
  issuedAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
};
const result = {
  scopeId: baseCommand.scopeId, organizationId: baseCommand.organizationId,
  phase: "inventoried", authorityGeneration: 1, legacyCount: 0, grantCount: 0,
  invitationCount: 0, nonOrganizationCount: 0, ceilingDigest: "a".repeat(64), idsDigest: "b".repeat(64),
  backupRef: "cutover:backup", backupInventoryRef: "cutover:backup", fenceEpoch: null, fenceDigest: null,
};

function envelope(command: typeof baseCommand | Record<string, unknown> = baseCommand) {
  return {
    command, keyId: "platform-key-1",
    signature: sign(null, Buffer.from(`matrix-collaboration-cutover-v1\n${canonicalJson(command)}`), pair.privateKey).toString("base64url"),
  };
}

function setup(options: { controlFresh?: boolean } = {}) {
  const inventory = vi.fn(async () => result);
  const drain = vi.fn(async (_key: unknown, callback: () => Promise<unknown>) => { await callback(); return result; });
  const drainRuns = vi.fn(async () => ({ interrupted: 0, remaining: 0 }));
  const app = new Hono();
  app.use("*", authMiddleware("owner-bearer-token"));
  app.route("/", createCollaborationCutoverRoutes({
    ownerId: baseCommand.ownerId, runtimeId: baseCommand.runtimeId,
    platformKeys: () => [{ keyId: "platform-key-1", algorithm: "ed25519", publicKey }],
    controlFresh: () => options.controlFresh ?? true,
    cutover: { inventory, drain } as never,
    drainRuns,
    now: () => NOW,
  }));
  return { app, inventory, drain, drainRuns };
}

async function post(app: Hono, body: unknown, bearer = true, route = path) {
  return app.request(route, { method: "POST", headers: {
    "content-type": "application/json", ...(bearer ? { authorization: "Bearer owner-bearer-token" } : {}),
  }, body: JSON.stringify(body) });
}

describe("S18 authenticated platform-to-home cutover transport", () => {
  it("requires both the normal home bearer and a fresh platform signature bound to owner, runtime, path and phase", async () => {
    const { app, inventory } = setup();
    expect((await post(app, envelope(), false)).status).toBe(401);
    expect((await post(app, { command: baseCommand, keyId: "platform-key-1", signature: "bad" })).status).toBe(401);
    expect((await post(app, envelope({ ...baseCommand, ownerId: "other_owner" }))).status).toBe(403);
    expect((await post(app, envelope({ ...baseCommand, path: `${path}/other` }))).status).toBe(403);
    const accepted = await post(app, envelope());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(result);
    expect(inventory).toHaveBeenCalledExactlyOnceWith({
      scopeId: baseCommand.scopeId, ownerId: baseCommand.ownerId, organizationId: baseCommand.organizationId,
      runtimeId: baseCommand.runtimeId, expectedSourceGeneration: 1, targetGeneration: 2,
      idempotencyKey: baseCommand.idempotencyKey,
    });
  });

  it("rejects nonce replay, stale commands and stale control before advancing a phase", async () => {
    const { app, inventory } = setup();
    expect((await post(app, envelope())).status).toBe(200);
    expect((await post(app, envelope())).status).toBe(409);
    expect((await post(app, envelope({ ...baseCommand, nonce: "50000000-0000-4000-8000-000000000002",
      expiresAt: new Date(NOW.getTime() - 1).toISOString() }))).status).toBe(401);
    expect(inventory).toHaveBeenCalledTimes(1);
    const stale = setup({ controlFresh: false });
    expect((await post(stale.app, envelope())).status).toBe(503);
    expect(stale.inventory).not.toHaveBeenCalled();
  });

  it("applies a bounded body and runs the canonical scoped drain callback on the home", async () => {
    const { app, drain, drainRuns } = setup();
    expect((await post(app, { huge: "x".repeat(70_000) })).status).toBe(413);
    const drainPath = path.replace("/inventory", "/drain");
    const command = { ...baseCommand, phase: "drain", path: drainPath };
    expect((await post(app, envelope(command), true, drainPath)).status).toBe(200);
    expect(drain).toHaveBeenCalledOnce();
    expect(drainRuns).toHaveBeenCalledExactlyOnceWith({
      scopeId: baseCommand.scopeId, ownerId: baseCommand.ownerId, organizationId: baseCommand.organizationId,
      runtimeId: baseCommand.runtimeId, expectedSourceGeneration: 1, targetGeneration: 2,
      idempotencyKey: baseCommand.idempotencyKey,
    });
  });
});
