import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authorize, handle, ownerRuntimeIdentity } from "../../packages/gateway/src/collaboration/route-support.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000002";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const directRequest = Buffer.from(JSON.stringify({ signature: "test-signature", proof: "a".repeat(43) })).toString("base64url");

describe("S19 direct admission boundary", () => {
  it("uses the signed direct session instead of a simultaneous V1 proof", async () => {
    const legacy = vi.fn();
    const direct = vi.fn(async () => ({ scopeId, actorId: "user_member", role: "editor" }));
    const app = new Hono();
    app.get("/scope", (c) => handle(c, async () => {
      const context = await authorize({ verifier: { verifyAndAuthorize: legacy } as never,
        directSessions: { authorize: direct } as never }, c, new Uint8Array(), "read", scopeId);
      return c.json({ actorId: context.actorId });
    }));

    const response = await app.request("/scope", { headers: {
      "x-matrix-collaboration-session": sessionId,
      "x-matrix-collaboration-request": directRequest,
      "x-matrix-collaboration-proof": "e30",
    } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actorId: "user_member" });
    expect(direct).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects incomplete direct credentials without trying the V1 verifier", async () => {
    const legacy = vi.fn();
    const direct = vi.fn();
    const app = new Hono();
    app.get("/scope", (c) => handle(c, async () => {
      await authorize({ verifier: { verifyAndAuthorize: legacy } as never,
        directSessions: { authorize: direct } as never }, c, new Uint8Array(), "read", scopeId);
      return c.text("unexpected");
    }));

    const response = await app.request("/scope", { headers: {
      "x-matrix-collaboration-session": sessionId,
      "x-matrix-collaboration-proof": "e30",
    } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Collaboration request denied" });
    expect(direct).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects an owner-runtime session for a different organization", async () => {
    const legacy = vi.fn();
    const authenticate = vi.fn(async () => ({ actorId: "user_owner", organizationId: "org_other" }));
    const app = new Hono();
    app.post("/create", (c) => handle(c, async () => {
      await ownerRuntimeIdentity({ verifier: { verifyHttp: legacy } as never,
        ownerRuntimeSessions: { authenticate } as never, runtimeId }, c,
      new Uint8Array(), runtimeId, "org_requested");
      return c.text("unexpected");
    }));

    const response = await app.request("/create", { method: "POST", headers: {
      "x-matrix-collaboration-session": sessionId,
      "x-matrix-collaboration-request": directRequest,
      "x-matrix-collaboration-proof": "e30",
    } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Collaboration unavailable", code: "forbidden" });
    expect(authenticate).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });
});
