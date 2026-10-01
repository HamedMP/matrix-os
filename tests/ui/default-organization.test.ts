import { describe, expect, it } from "vitest";
import { pickDefaultOrganizationId } from "../../packages/ui/src/collaboration/default-organization";

describe("pickDefaultOrganizationId", () => {
  it("picks the oldest organization, whose Clerk id sorts first", () => {
    // Clerk ids are KSUIDs: base62 with a leading timestamp, so code-unit order is creation order.
    expect(pickDefaultOrganizationId(["org_2ZbNewer", "org_2NbOlder", "org_2abLatest"])).toBe("org_2NbOlder");
  });

  it("compares by code unit, not locale, so uppercase sorts before lowercase as in base62", () => {
    expect(pickDefaultOrganizationId(["org_2a", "org_2Z"])).toBe("org_2Z");
  });

  it("has no default for a user in no organization", () => {
    expect(pickDefaultOrganizationId([])).toBeNull();
  });
});
