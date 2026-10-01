import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID, JEV_PRICING_VERSION } from "@matrix-os/contracts";
import { fixedJevProbeRequest } from "../../packages/proxy/src/funded-relay-jev-probe.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";

const defaultNow = new Date("2026-09-26T00:00:00.000Z");
const token = `sk-matrix-funded-credential_fixture.${"s".repeat(43)}`;
function fixture(mode = "valid", reviewEnv: NodeJS.ProcessEnv = {}, now = defaultNow) {
  let clock = now;
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const finalizations: Record<string, unknown>[] = [];
  const events: string[] = [];
  const identity = { tokenId: "credential_fixture", ownerId: "owner_fixture", machineId: "machine_fixture", runtimeSlot: "primary",
    audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: later(15) };
  const policy = { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [JEV_MODEL_ID],
    monthlyBudgetMicrousd: 100_000, checkedAt: now.toISOString(), staleAfter: later(1) };
  const funding = { asOf: now.toISOString(), periodStart: "2026-09-01T00:00:00.000Z", monthlyBudgetMicrousd: 100_000,
    settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 100_000,
    addonBalanceMicrousd: 0, creditBalanceMicrousd: 100_000, remainingBalanceMicrousd: 100_000, remainingBudgetMicrousd: 100_000 };
  const fetchFn = vi.fn<typeof fetch>(async (raw, init) => {
    const url = String(raw);
    if (url.startsWith("https://platform.example.test/")) {
      const action = url.split("/").at(-1)!; events.push(action);
      if (mode === `review-expires-during-${action}`) {
        await Promise.resolve();
        clock = new Date(Date.parse(reviewEnv.MATRIX_JEV_PRICING_VALID_THROUGH!) + 1);
      }
      if (action === "check") {
        if (mode === "revoked" && events.filter(event => event === "check").length > 1) return Response.json({}, { status: 403 });
        return Response.json({ contractVersion: 1, authorized: true, identity, policy });
      }
      if (action === "authorize") return Response.json({ contractVersion: 1, authorized: true, identity, policy,
        funding: { ...funding, reservedMicrousd: 5_000, reservedThisMonthMicrousd: 5_000, remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000 },
        reservation: { reservationId: "reservation_fixture", requestId: "request_fixture", modelId: JEV_MODEL_ID,
          reservedMicrousd: 5_000, maxCostMicrousd: 5_000, billingMode: "usage", jevPricingVersion: JEV_PRICING_VERSION,
          remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000, periodStart: funding.periodStart,
          expiresAt: later(5), status: "reserved" } });
      if (action === "start") return Response.json({ contractVersion: 1, reservationId: "reservation_fixture", requestId: "request_fixture",
        tokenId: identity.tokenId, startedAt: now.toISOString(), expiresAt: later(5), status: "in_flight" });
      if (action === "release") return Response.json({ contractVersion: 1, reservationId: "reservation_fixture", requestId: "request_fixture",
        tokenId: identity.tokenId, releasedMicrousd: 5_000, releasedAt: clock.toISOString(), reason: "pre_upstream_failure",
        status: "released", funding });
      if (action === "finalize") {
        finalizations.push(JSON.parse(String(init?.body)));
        if (mode === "settlement-failure") return Response.json({}, { status: 503 });
        return Response.json({ contractVersion: 1, reservationId: mode === "wrong-finalization" ? "other_reservation" : "reservation_fixture",
          requestId: "request_fixture", tokenId: identity.tokenId, actualCostMicrousd: 12, chargedCostMicrousd: 12,
          matrixAbsorbedMicrousd: 0, releasedMicrousd: 4_988, remainingBalanceMicrousd: 99_988, remainingBudgetMicrousd: 99_988,
          funding: { ...funding, settledThisMonthMicrousd: 12, promotionalBalanceMicrousd: 99_988,
            creditBalanceMicrousd: 99_988, remainingBalanceMicrousd: 99_988, remainingBudgetMicrousd: 99_988 },
          settledAt: now.toISOString(), status: "settled", finalizationMode: "exact" });
      }
      throw new Error("Unexpected synthetic control action");
    }
    events.push("evaluate");
    if (mode === "review-expires") clock = new Date(Date.parse(reviewEnv.MATRIX_JEV_PRICING_VALID_THROUGH!) + 1);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(JEV_MODEL_ID); expect(body.input.state).toBe("Synthetic Jev readiness check. No email or owner data.");
    const result = { model: "jev-1.13.0", answers: Object.fromEntries(JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => [id, { type: "noul", noul: 0.1 }])),
      ...(mode === "missing-usage" ? {} : { usage: { input_tokens: 275, output_tokens: 0 } }) };
    return Response.json({ success: true, errors: [], messages: [], result: { state: "Completed", result } });
  });
  const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/fixture/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
    PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32), ...reviewEnv })!;
  const relay = createFundedRelay({ ...config, fetch: fetchFn, now: () => clock, requestIdFactory: () => "request_fixture" });
  const app = new Hono(); relay.register(app);
  const request = (control = config.relayControlToken, body = "{}") => app.request("/v1/jev-readiness", { method: "POST",
    headers: { authorization: `Bearer ${control}`, "x-api-key": token, "content-type": "application/json" }, body });
  const evaluation = () => app.request("/v1/evaluate", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" },
    body: JSON.stringify(fixedJevProbeRequest()) });
  return { relay, events, request, evaluation, finalizations };
}
it("awaits exact owner-funded settlement before marking the fixed Jev readiness probe ready", async () => {
  const f = fixture();
  try {
    const response = await f.request(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true, priceValidThrough: "2026-09-30T23:59:59.999Z" });
    expect(f.events).toEqual(["check", "authorize", "start", "evaluate", "finalize", "check"]);
  } finally { await f.relay.close(); }
});
it.each(["missing-usage", "settlement-failure", "wrong-finalization", "revoked"])("never marks %s probe ready", async mode => {
  const f = fixture(mode);
  try { expect((await f.request()).status).not.toBe(200); } finally { await f.relay.close(); }
});
it.each(["wrong-control", "caller-body"])("denies %s before paid probe", async mode => {
  const f = fixture();
  try {
    expect((await f.request(mode === "wrong-control" ? "wrong" : undefined, mode === "caller-body" ? '{"state":"private"}' : "{}")).status).toBe(mode === "wrong-control" ? 403 : 400);
    expect(f.events).toEqual([]);
  } finally { await f.relay.close(); }
});

const renewedReview = {
  MATRIX_JEV_PRICING_REVIEW_VERSION: JEV_PRICING_VERSION,
  MATRIX_JEV_PRICING_REVIEWED_AT: "2026-10-01T00:00:00.000Z",
  MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-31T23:59:59.999Z",
};
it("runs the October owner-funded probe and exposes the actual configured review expiry", async () => {
  const f = fixture("valid", renewedReview, new Date("2026-10-01T00:00:00.000Z"));
  try {
    const response = await f.request(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true, priceValidThrough: renewedReview.MATRIX_JEV_PRICING_VALID_THROUGH });
    expect(f.finalizations).toContainEqual(expect.objectContaining({ mode: "exact", actualCostMicrousd: 12,
      jevProvenance: { resolvedModel: "jev-1.13.0", pricingVersion: JEV_PRICING_VERSION } }));
  } finally { await f.relay.close(); }
});
it.each([{}, { ...renewedReview, MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-01T00:00:00.001Z" },
  { ...renewedReview, MATRIX_JEV_PRICING_REVIEWED_AT: "2026-10-02T00:00:00.000Z" }])(
  "denies absent, expired or future reviews before reservation and dispatch", async reviewEnv => {
    const f = fixture("valid", reviewEnv, new Date("2026-10-01T00:00:00.010Z"));
    try {
      const response = await f.request(); expect(response.status).toBe(503);
      expect(response.headers.get("x-matrix-jev-dispatch")).toBe("not-started");
      expect(f.events).toEqual([]);
    } finally { await f.relay.close(); }
  });
it("retains exact accounting but never reports ready if review expires during the paid probe", async () => {
  const f = fixture("review-expires", { ...renewedReview, MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-01T00:00:00.020Z" },
    new Date("2026-10-01T00:00:00.000Z"));
  try {
    expect((await f.request()).status).not.toBe(200);
    expect(f.events).toContain("evaluate");
    expect(f.finalizations).toContainEqual(expect.objectContaining({ mode: "exact", actualCostMicrousd: 12 }));
  } finally { await f.relay.close(); }
});

it("settles an already-started evaluation with its admitted price when review expires in flight", async () => {
  const f = fixture("review-expires", { ...renewedReview, MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-01T00:00:00.020Z" },
    new Date("2026-10-01T00:00:00.000Z"));
  try {
    expect((await f.evaluation()).status).toBe(200);
    await vi.waitFor(() => expect(f.finalizations).toContainEqual(expect.objectContaining({ mode: "exact", actualCostMicrousd: 12,
      jevProvenance: { resolvedModel: "jev-1.13.0", pricingVersion: JEV_PRICING_VERSION } })));
  } finally { await f.relay.close(); }
});

it.each([
  ["check", ["check"]],
  ["authorize", ["check", "authorize", "release"]],
] as const)("rejects pricing expiry during %s before paid dispatch", async (action, expectedEvents) => {
  const f = fixture(`review-expires-during-${action}`, { ...renewedReview,
    MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-01T00:00:00.020Z" }, new Date("2026-10-01T00:00:00.000Z"));
  try {
    const response = await f.evaluation();
    expect(response.status).not.toBe(200);
    expect(response.headers.get("x-matrix-jev-dispatch")).toBe("not-started");
    expect(f.events).toEqual(expectedEvents);
    expect(f.finalizations).toEqual([]);
  } finally { await f.relay.close(); }
});

it.each(["evaluation", "readiness"])("blocks %s dispatch when its admitted review expires during reservation start", async route => {
  const f = fixture("review-expires-during-start", { ...renewedReview,
    MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-01T00:00:00.020Z" }, new Date("2026-10-01T00:00:00.000Z"));
  try {
    const response = await (route === "evaluation" ? f.evaluation() : f.request());
    expect(response.status).not.toBe(200);
    expect(f.events).toEqual(["check", "authorize", "start"]);
    expect(f.finalizations).toEqual([]);
  } finally { await f.relay.close(); }
});
