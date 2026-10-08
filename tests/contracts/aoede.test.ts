import { describe, expect, it } from "vitest";
import { AoedeBootstrapRequestSchema } from "../../packages/contracts/src/aoede.js";

describe("Aoede bootstrap contract", () => {
  it("limits this delivery to browser canvas and desktop surfaces", () => {
    for (const surface of ["web_canvas", "web_desktop"] as const) {
      expect(AoedeBootstrapRequestSchema.safeParse({
        clientRequestId: "req_aoede_surface",
        intent: "continue",
        surface,
      }).success).toBe(true);
    }
    expect(AoedeBootstrapRequestSchema.safeParse({
      clientRequestId: "req_aoede_surface",
      intent: "continue",
      surface: "electron_desktop",
    }).success).toBe(false);
  });
});
