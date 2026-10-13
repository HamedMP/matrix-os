import { describe, expect, it } from "vitest";
import { AOEDE_LIVE_PREVIEW } from "../../shell/src/lib/feature-flags.js";

describe("PR 2386 Aoede preview visibility", () => {
  it("keeps the Live Aoede surface enabled without deployment environment coupling", () => {
    expect(AOEDE_LIVE_PREVIEW).toBe(true);
  });
});
