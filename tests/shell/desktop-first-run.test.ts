import { describe, expect, it } from "vitest";

import {
  parseDesktopFirstRunStatus,
  shouldApplyInitialDesktopDefaults,
} from "../../shell/src/lib/desktop-first-run.js";

describe("desktop first-run helpers", () => {
  it("applies initial defaults only when onboarding is incomplete", () => {
    expect(shouldApplyInitialDesktopDefaults(parseDesktopFirstRunStatus({ complete: false }))).toBe(true);
    expect(shouldApplyInitialDesktopDefaults(parseDesktopFirstRunStatus({ complete: true }))).toBe(false);
    expect(shouldApplyInitialDesktopDefaults("ready")).toBe(false);
  });

  it("rejects malformed onboarding status payloads", () => {
    expect(() => parseDesktopFirstRunStatus({})).toThrow("invalid onboarding status");
    expect(() => parseDesktopFirstRunStatus(null)).toThrow("invalid onboarding status");
  });
});
