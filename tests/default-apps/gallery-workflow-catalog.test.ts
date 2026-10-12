import { describe, expect, it } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import { AppGalleryCatalogSchema, deriveGalleryReadiness } from "../../packages/contracts/src/app-gallery";
import { importPrompt } from "../../home/app-templates/connected-starter/src/import";
import type { Definition } from "../../home/app-templates/connected-starter/src/types";
import { getAction } from "../../packages/gateway/src/integrations/registry";

const heroes = ["subscriptions", "workout-coach", "folio", "agenda", "atlas", "paycheck-runway", "meal-planner", "meeting-briefs", "job-search", "study-notes", "journal-memory", "people", "cashflow", "projects", "chess-coach"];
describe("research-backed gallery workflows", () => {
  it("contains every top fifteen workflow and preserves the existing twenty-four stable slugs", () => {
    expect(AppGalleryCatalogSchema.parse(catalog).apps).toHaveLength(31);
    for (const id of heroes) expect(catalog.apps.find(app => app.id === id), id).toBeDefined();
    for (const id of ["focus", "follow-ups", "company-spend", "analytics", "hiring", "releases", "revenue"]) expect(catalog.apps.some(app => app.id === id)).toBe(true);
  });
  it("advertises executable read actions only", () => {
    for (const app of catalog.apps) for (const service of app.services) for (const action of service.actions) {
      expect(getAction(service.id, action)?.risk, `${app.id}/${service.id}/${action}`).toBe("read");
    }
  });
  it("keeps inferred dates distinct from confirmed renewal and invoice deadlines", () => {
    const subscriptions = catalog.apps.find(app => app.id === "subscriptions")!;
    expect(subscriptions.fields.map(field => field.key)).toContain("renewal-certainty");
    expect(catalog.apps.find(app => app.id === "cashflow")!.fields.map(field => field.key)).toContain("due-date");
  });
  it("keeps a immediately useful manual path for the private and planning apps", () => {
    for (const id of ["workout-coach", "paycheck-runway", "meal-planner", "journal-memory", "chess-coach"]) expect(catalog.apps.find(app => app.id === id)?.services).toEqual([]);
  });
  it("can enrich an invoice queue from one exact account without requiring both alternative sources", () => {
    const app = catalog.apps.find(app => app.id === "cashflow")!;
    const inventory = [{ id: "stripe_owner", service: "stripe", account_label: "Work", account_email: null, status: "active" }];
    expect(deriveGalleryReadiness(app as never, inventory).status).toBe("ready");
    const prompt = importPrompt(app as Definition, { accounts: [{ service: "stripe", label: "Work", connectionId: "stripe_owner", expectedEmail: null }], start: "2026-07-01", end: "2026-10-07", context: "Only selected invoice account" }, inventory);
    expect(prompt).toContain("stripe_owner");
    expect(deriveGalleryReadiness(app as never, []).status).toBe("needs_connection");
    expect(() => importPrompt(app as Definition, { accounts: [], start: "2026-07-01", end: "2026-10-07", context: "" }, [])).toThrow("Choose an exact account");
  });
});
