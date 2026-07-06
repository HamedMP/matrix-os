import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MATRIX_TELEMETRY_EVENTS } from "../../packages/observability/src/events.js";

const src = readFileSync(
  join(process.cwd(), "www/src/components/landing/LandingBilling.tsx"),
  "utf8",
);

describe("landing billing is clickable", () => {
  it("sources plan data from the canonical module", () => {
    expect(src).toContain('from "@/lib/billing-plans"');
    expect(src).toContain("LANDING_PLANS");
  });

  it("links each plan row to sign-up with its url slug", () => {
    expect(src).toContain("/sign-up?plan=${plan.urlSlug}");
  });

  it("emits plan-click telemetry through the canonical event", () => {
    expect(src).toContain("MATRIX_TELEMETRY_EVENTS.MARKETING_BILLING_PLAN_CLICKED");
    expect(MATRIX_TELEMETRY_EVENTS.MARKETING_BILLING_PLAN_CLICKED).toBe(
      "matrix_marketing_billing_plan_clicked",
    );
  });

  it("drops the duplicated inline plans array", () => {
    expect(src).not.toContain('machine: "CPX22"');
  });
});
