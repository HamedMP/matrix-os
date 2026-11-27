import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority.js";
import { handle } from "../../packages/gateway/src/collaboration/route-support.js";

// Outcome (ENG-579): a member's write to a view-only shared app is reported as view-only, so the
// client keeps the app open instead of showing "Access ended".
// Fault detected: the refusal reaching clients as a generic `forbidden` access loss.
describe("collaboration route error mapping", () => {
  const app = new Hono();
  app.get("/read-only", (c) => handle(c, async () => {
    throw new CollaborationAuthorizationError("forbidden", "Shared app is view-only", "read_only");
  }));
  app.get("/forbidden", (c) => handle(c, async () => {
    throw new CollaborationAuthorizationError("forbidden", "Role does not allow this action");
  }));

  it("returns a distinct read_only code without internal details", async () => {
    const response = await app.request("/read-only");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This app is view-only", code: "read_only" });
  });

  it("keeps other forbidden refusals unchanged", async () => {
    const response = await app.request("/forbidden");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Collaboration unavailable", code: "forbidden" });
  });
});
