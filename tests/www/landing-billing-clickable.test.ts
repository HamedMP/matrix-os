import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("emits plan-click telemetry", () => {
    expect(src).toContain("marketing_billing_plan_clicked");
  });

  it("drops the duplicated inline plans array", () => {
    expect(src).not.toContain('machine: "CPX22"');
  });
});
