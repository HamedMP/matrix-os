import { describe, expect, it } from "vitest";

import {
  parseDesktopFirstRunStatus,
} from "../../shell/src/lib/desktop-first-run.js";

describe("desktop first-run helpers", () => {
  it("rejects malformed onboarding status payloads", () => {
    expect(() => parseDesktopFirstRunStatus({})).toThrow("invalid onboarding status");
    expect(() => parseDesktopFirstRunStatus(null)).toThrow("invalid onboarding status");
  });

});
