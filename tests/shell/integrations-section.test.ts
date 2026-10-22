import { describe, it, expect } from "vitest";
import {
  hasCompletedConnectionForService,
  shouldLogIntegrationWarning,
} from "../../shell/src/components/settings/sections/integrations-helpers";

describe("IntegrationsSection polling helper", () => {
  it("ignores newly added connections for a different service", () => {
    const previous = [{ id: "gmail-1", service: "gmail", status: "active", connected_at: "2026-10-01T00:00:00Z" }];
    const list = [
      { id: "gmail-1", service: "gmail", status: "active", connected_at: "2026-10-01T00:00:00Z" },
      { id: "slack-1", service: "slack", status: "active", connected_at: "2026-10-01T00:00:00Z" },
    ];

    expect(hasCompletedConnectionForService(previous, "gmail", list)).toBe(false);
  });

  it("detects a newly added connection for the requested service", () => {
    const previous = [{ id: "gmail-1", service: "gmail", status: "active", connected_at: "2026-10-01T00:00:00Z" }];
    const list = [
      { id: "gmail-1", service: "gmail", status: "active", connected_at: "2026-10-01T00:00:00Z" },
      { id: "gmail-2", service: "gmail", status: "active", connected_at: "2026-10-01T00:00:00Z" },
    ];

    expect(hasCompletedConnectionForService(previous, "gmail", list)).toBe(true);
  });

  it("suppresses timeout warnings for AbortError", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(shouldLogIntegrationWarning(err)).toBe(false);
  });

  it("logs non-timeout polling failures", () => {
    expect(shouldLogIntegrationWarning(new Error("ECONNREFUSED"))).toBe(true);
  });
});
