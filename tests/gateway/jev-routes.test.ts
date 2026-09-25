import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID } from "@matrix-os/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createJevRoutes } from "../../packages/gateway/src/jev/routes.js";
import { JevServiceError } from "../../packages/gateway/src/jev/service.js";

const valid = {
  recipe: "email-triage-v1",
  state: "hello",
  idempotencyKey: "thread:abc123",
};

describe("Jev Gateway routes", () => {
  it("accepts only the bounded public recipe contract", async () => {
    const evaluate = vi.fn(async () => ({
      requestId: "jev_req_request_123", recipe: "email-triage-v1" as const, model: JEV_MODEL_ID,
      latencyMs: 1,
      answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, type: "boolean" as const, probability: 0.5 })),
    }));
    const app = new Hono();
    app.route("/api/jev", createJevRoutes({ service: { evaluate }, resolveOwnerId: () => "owner_a" }));
    const response = await app.request("/api/jev/evaluate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
    });
    expect(response.status).toBe(200);
    expect(evaluate).toHaveBeenCalledWith("owner_a", valid, expect.any(AbortSignal));

    const injected = await app.request("/api/jev/evaluate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...valid, model: "attacker/model", questions: {} }),
    });
    expect(injected.status).toBe(400);
  });

  it("enforces the body limit before parsing", async () => {
    const app = new Hono();
    app.route("/api/jev", createJevRoutes({
      service: { evaluate: vi.fn() }, resolveOwnerId: () => "owner_a",
    }));
    const response = await app.request("/api/jev/evaluate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...valid, state: "x".repeat(70_000) }),
    });
    expect(response.status).toBe(413);
  });

  it("returns safe typed errors without leaking provider details", async () => {
    const app = new Hono();
    app.route("/api/jev", createJevRoutes({
      service: { evaluate: vi.fn(async () => { throw new JevServiceError("unavailable"); }) },
      resolveOwnerId: () => "owner_a",
    }));
    const response = await app.request("/api/jev/evaluate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "unavailable", message: "Jev is temporarily unavailable" } });
  });

  it("distinguishes a pruned completed result from an unknown outcome", async () => {
    const app = new Hono();
    app.route("/api/jev", createJevRoutes({
      service: { evaluate: vi.fn(async () => { throw new JevServiceError("result_expired"); }) },
      resolveOwnerId: () => "owner_a",
    }));
    const response = await app.request("/api/jev/evaluate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: { code: "result_expired", message: "This Jev result has expired" },
    });
  });
});
