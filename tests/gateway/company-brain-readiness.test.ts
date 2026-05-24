import { describe, expect, it } from "vitest";
import { createCompanyBrainRoutes } from "../../packages/gateway/src/onboarding/company-brain-routes.js";
import { createCompanyBrainReadinessService } from "../../packages/gateway/src/onboarding/company-brain-readiness.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("company brain readiness", () => {
  it("starts with a safe needs-context state", async () => {
    const service = createCompanyBrainReadinessService();
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("/readiness");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("needs_context");
    expect(body.items).toEqual([]);
    expect(body.guidance).toContain("Add a product decision");
    expect(JSON.stringify(body)).not.toMatch(/secret|token|postgres|\/home\//i);
  });

  it("captures owner-scoped company context with source references", async () => {
    const service = createCompanyBrainReadinessService({
      now: () => new Date("2026-05-23T00:00:00.000Z"),
    });
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });

    const created = await app.request(post("/context", {
      type: "product_decision",
      title: "Launch ICP",
      summary: "Paid beta targets technical founders and developers.",
      source: "specs/launch-readiness",
      visibility: "owner_only",
    }));

    expect(created.status).toBe(200);
    const readiness = await (await app.request("/readiness")).json();
    expect(readiness.status).toBe("ready");
    expect(readiness.items).toEqual([
      expect.objectContaining({
        title: "Launch ICP",
        source: "specs/launch-readiness",
        visibility: "owner_only",
      }),
    ]);
    expect(readiness.sourceLinks).toEqual(["specs/launch-readiness"]);
  });

  it("preserves safe summaries up to the route schema limit", async () => {
    const service = createCompanyBrainReadinessService({
      now: () => new Date("2026-05-23T00:00:00.000Z"),
    });
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });
    const summary = "a".repeat(780);

    const res = await app.request(post("/context", {
      type: "product_decision",
      title: "Launch ICP",
      summary,
      source: "specs/launch-readiness",
      visibility: "owner_only",
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ summary });
  });

  it("redacts unsafe fragments without replacing company context", async () => {
    const service = createCompanyBrainReadinessService();
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/context", {
      type: "customer_note",
      title: "Customer database migration",
      summary: "Customer asked about database status; token=sk_test_secret must not be shown.",
      source: "/home/matrix/notes/customer.md",
      visibility: "owner_only",
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toContain("Customer");
    expect(body.summary).toContain("Customer asked");
    expect(body.summary).toContain("[redacted]");
    expect(body.source).toBe("[redacted]");
    expect(JSON.stringify(body)).not.toMatch(/database|token|secret|sk_test|\/home\//i);
  });

  it("marks stale and contradictory context for review", async () => {
    const service = createCompanyBrainReadinessService();
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(post("/context", {
      type: "product_decision",
      title: "Old pricing",
      summary: "stale contradiction: launch price is unknown",
      source: "notes/pricing",
      visibility: "owner_only",
    }));
    const body = await (await app.request("/readiness")).json();

    expect(body.status).toBe("needs_review");
    expect(body.reviewFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "stale" }),
      expect.objectContaining({ kind: "contradiction" }),
    ]));
  });

  it("does not mark longer words containing stale as stale context", async () => {
    const service = createCompanyBrainReadinessService();
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(post("/context", {
      type: "product_decision",
      title: "Roadmap stalemate",
      summary: "The team is resolving a stalemate over packaging.",
      source: "notes/roadmap",
      visibility: "owner_only",
    }));
    const body = await (await app.request("/readiness")).json();

    expect(body.status).toBe("ready");
    expect(body.reviewFlags).toEqual([]);
  });

  it("does not mark non-contradictory context as a contradiction", async () => {
    const service = createCompanyBrainReadinessService();
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(post("/context", {
      type: "product_decision",
      title: "Pricing alignment",
      summary: "The new offer is non-contradictory with the free tier.",
      source: "notes/pricing",
      visibility: "owner_only",
    }));
    const body = await (await app.request("/readiness")).json();

    expect(body.status).toBe("ready");
    expect(body.reviewFlags).toEqual([]);
  });

  it("marks contradict and contradictions wording for review", async () => {
    const service = createCompanyBrainReadinessService();
    const app = createCompanyBrainRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(post("/context", {
      type: "product_decision",
      title: "Pricing mismatch",
      summary: "These entries contradict each other and create contradictions in the pricing docs.",
      source: "notes/pricing",
      visibility: "owner_only",
    }));
    const body = await (await app.request("/readiness")).json();

    expect(body.status).toBe("needs_review");
    expect(body.reviewFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contradiction" }),
    ]));
  });
});
