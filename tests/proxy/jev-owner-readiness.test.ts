import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID, JEV_PRICING_VERSION } from "@matrix-os/contracts";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";

const now = new Date("2026-09-26T00:00:00.000Z");
const token = `sk-matrix-funded-credential_fixture.${"s".repeat(43)}`;
function fixture(mode = "valid") {
  const events: string[] = [];
  const identity = { tokenId: "credential_fixture", ownerId: "owner_fixture", machineId: "machine_fixture", runtimeSlot: "primary",
    audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-26T00:15:00.000Z" };
  const policy = { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [JEV_MODEL_ID],
    monthlyBudgetMicrousd: 100_000, checkedAt: now.toISOString(), staleAfter: "2026-09-26T00:01:00.000Z" };
  const funding = { asOf: now.toISOString(), periodStart: "2026-09-01T00:00:00.000Z", monthlyBudgetMicrousd: 100_000,
    settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 100_000,
    addonBalanceMicrousd: 0, creditBalanceMicrousd: 100_000, remainingBalanceMicrousd: 100_000, remainingBudgetMicrousd: 100_000 };
  const fetchFn = vi.fn<typeof fetch>(async (raw, init) => {
    const url = String(raw);
    if (url.startsWith("https://platform.example.test/")) {
      const action = url.split("/").at(-1)!; events.push(action);
      if (action === "check") {
        if (mode === "revoked" && events.filter(event => event === "check").length > 1) return Response.json({}, { status: 403 });
        return Response.json({ contractVersion: 1, authorized: true, identity, policy });
      }
      if (action === "authorize") return Response.json({ contractVersion: 1, authorized: true, identity, policy,
        funding: { ...funding, reservedMicrousd: 5_000, reservedThisMonthMicrousd: 5_000, remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000 },
        reservation: { reservationId: "reservation_fixture", requestId: "request_fixture", modelId: JEV_MODEL_ID,
          reservedMicrousd: 5_000, maxCostMicrousd: 5_000, billingMode: "usage", jevPricingVersion: JEV_PRICING_VERSION,
          remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000, periodStart: funding.periodStart,
          expiresAt: "2026-09-26T00:05:00.000Z", status: "reserved" } });
      if (action === "start") return Response.json({ contractVersion: 1, reservationId: "reservation_fixture", requestId: "request_fixture",
        tokenId: identity.tokenId, startedAt: now.toISOString(), expiresAt: "2026-09-26T00:05:00.000Z", status: "in_flight" });
      if (action === "finalize") {
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
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(JEV_MODEL_ID); expect(body.input.state).toBe("Synthetic Jev readiness check. No email or owner data.");
    const result = { model: "jev-1.13.0", answers: Object.fromEntries(JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => [id, { type: "noul", noul: 0.1 }])),
      ...(mode === "missing-usage" ? {} : { usage: { input_tokens: 275, output_tokens: 0 } }) };
    return Response.json({ success: true, errors: [], messages: [], result: { state: "Completed", result } });
  });
  const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/fixture/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
    PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32) })!;
  const relay = createFundedRelay({ ...config, fetch: fetchFn, now: () => now, requestIdFactory: () => "request_fixture" });
  const app = new Hono(); relay.register(app);
  const request = (control = config.relayControlToken, body = "{}") => app.request("/v1/jev-readiness", { method: "POST",
    headers: { authorization: `Bearer ${control}`, "x-api-key": token, "content-type": "application/json" }, body });
  return { relay, events, request };
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
