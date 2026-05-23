import { describe, expect, it } from "vitest";
import { createDraftActionRoutes } from "../../packages/gateway/src/onboarding/draft-action-routes.js";
import { createDraftActionReadinessService } from "../../packages/gateway/src/onboarding/draft-action-readiness.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("support and growth draft readiness", () => {
  it("creates review-first drafts with uncertainty and sensitive claim flags", async () => {
    const service = createDraftActionReadinessService({
      now: () => new Date("2026-05-23T00:00:00.000Z"),
    });
    const app = createDraftActionRoutes({ service, getPrincipal: () => testPrincipal });

    const created = await app.request(post("/drafts", {
      type: "support_reply",
      content: "We can guarantee 99.999% uptime, but I am unsure about the current SLA.",
      destination: "Customer ticket #42",
      createdByAgent: "hermes",
    }));

    expect(created.status).toBe(200);
    const draft = await created.json();
    expect(draft.status).toBe("needs_review");
    expect(draft.uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "uncertainty" }),
      expect.objectContaining({ kind: "sensitive_claim" }),
    ]));
    expect(JSON.stringify(draft)).not.toMatch(/secret|token|\/home\//i);
  });

  it("requires explicit approval before a draft can be marked approved", async () => {
    const service = createDraftActionReadinessService();
    const app = createDraftActionRoutes({ service, getPrincipal: () => testPrincipal });
    const draft = await (await app.request(post("/drafts", {
      type: "social_post",
      content: "Matrix helps founders ship code and operate support.",
      destination: "LinkedIn",
      createdByAgent: "hermes",
    }))).json();

    const approved = await app.request(post(`/drafts/${draft.id}/approval`, { approved: true }));

    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      id: draft.id,
      status: "approved",
      approvalSummary: "Draft approved for external action",
    });
  });

  it("returns safe readiness summaries for pending drafts", async () => {
    const service = createDraftActionReadinessService();
    const app = createDraftActionRoutes({ service, getPrincipal: () => testPrincipal });
    await app.request(post("/drafts", {
      type: "acquisition_message",
      content: "Draft for an early founder lead.",
      destination: "Outbound queue",
      createdByAgent: "hermes",
    }));

    const body = await (await app.request("/readiness")).json();

    expect(body.status).toBe("needs_review");
    expect(body.pendingReview).toBe(1);
    expect(body.guidance).toContain("Review drafts");
  });

  it("does not flag polite May support openers as uncertain language", async () => {
    const service = createDraftActionReadinessService();
    const app = createDraftActionRoutes({ service, getPrincipal: () => testPrincipal });

    const created = await app.request(post("/drafts", {
      type: "support_reply",
      content: "May I clarify which plan you're on before I send the setup steps?",
      destination: "Customer ticket #45",
      createdByAgent: "hermes",
    }));

    const draft = await created.json();
    expect(draft.uncertainties).toEqual([]);
  });

  it("does not flag words that contain never as sensitive claims", async () => {
    const service = createDraftActionReadinessService();
    const app = createDraftActionRoutes({ service, getPrincipal: () => testPrincipal });

    const created = await app.request(post("/drafts", {
      type: "support_reply",
      content: "Nevertheless, the setup steps are ready for your team.",
      destination: "Customer ticket #46",
      createdByAgent: "hermes",
    }));

    const draft = await created.json();
    expect(draft.uncertainties).toEqual([]);
  });

  it("flags might before punctuation as uncertain language", async () => {
    const service = createDraftActionReadinessService();
    const app = createDraftActionRoutes({ service, getPrincipal: () => testPrincipal });

    const created = await app.request(post("/drafts", {
      type: "support_reply",
      content: "The timeline might?",
      destination: "Customer ticket #47",
      createdByAgent: "hermes",
    }));

    const draft = await created.json();
    expect(draft.uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "uncertainty" }),
    ]));
  });
});
