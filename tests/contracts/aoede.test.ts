import { describe, expect, it } from "vitest";
import { AoedeBootstrapRequestSchema } from "../../packages/contracts/src/aoede.js";

describe("Aoede bootstrap contract", () => {
  it("accepts the three shared OS surfaces and defers native mobile", () => {
    for (const surface of ["web_canvas", "web_desktop", "electron_desktop"] as const) {
      expect(AoedeBootstrapRequestSchema.safeParse({
        clientRequestId: "req_aoede_surface",
        intent: "continue",
        surface,
      }).success).toBe(true);
    }
    expect(AoedeBootstrapRequestSchema.safeParse({
      clientRequestId: "req_aoede_surface",
      intent: "continue",
      surface: "native_mobile",
    }).success).toBe(false);
  });
});
