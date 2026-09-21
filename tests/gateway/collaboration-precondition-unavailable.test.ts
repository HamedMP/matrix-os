/**
 * S20 / T100: a missing or failing membership source is a missing server
 * dependency. It must surface as a generic unavailable denial (503 on HTTP),
 * never as not-found and never as an allow; an actor who is simply not a
 * member stays a generic not-found denial.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority-error.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { handle } from "../../packages/gateway/src/collaboration/route-support.js";

describe("organization precondition: dependency failures are unavailable, not not-found", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports no registered membership source as unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const precondition = createOrganizationPrecondition();
    await expect(precondition.require({ organizationId: "org_matrix_team", actorId: "user_a" }))
      .rejects.toMatchObject({ code: "unavailable", message: "Collaboration unavailable" });
  });

  it("reports a failing membership source as unavailable and a non-member as not found", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const precondition = createOrganizationPrecondition({ now: () => new Date("2026-09-21T00:00:00.000Z") });
    precondition.registerSource({
      assertMembership: async () => {
        if (fail) throw new Error("clerk timeout");
        return { member: false };
      },
    });
    await expect(precondition.require({ organizationId: "org_matrix_team", actorId: "user_a" }))
      .rejects.toMatchObject({ code: "unavailable" });
    fail = false;
    await expect(precondition.require({ organizationId: "org_matrix_team", actorId: "user_a" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("maps the unavailable authorization code to a generic 503 on collaboration routes", async () => {
    const app = new Hono();
    app.get("/unavailable", (c) => handle(c, async () => {
      throw new CollaborationAuthorizationError("unavailable", "Collaboration unavailable");
    }));
    app.get("/denied", (c) => handle(c, async () => {
      throw new CollaborationAuthorizationError("not_found", "Current membership is required");
    }));
    const unavailable = await app.request("/unavailable");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Collaboration unavailable", code: "unavailable" });
    const denied = await app.request("/denied");
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "Collaboration unavailable", code: "not_found" });
  });
});
