import { describe, it, expect } from "vitest";
import { hasNewConnectionForService } from "../../shell/src/components/settings/sections/IntegrationsSection";

describe("IntegrationsSection polling helper", () => {
  it("ignores newly added connections for a different service", () => {
    const previousIds = new Set(["gmail-1"]);
    const list = [
      { id: "gmail-1", service: "gmail" },
      { id: "slack-1", service: "slack" },
    ];

    expect(hasNewConnectionForService(previousIds, "gmail", list)).toBe(false);
  });

  it("detects a newly added connection for the requested service", () => {
    const previousIds = new Set(["gmail-1"]);
    const list = [
      { id: "gmail-1", service: "gmail" },
      { id: "gmail-2", service: "gmail" },
    ];

    expect(hasNewConnectionForService(previousIds, "gmail", list)).toBe(true);
  });
});
