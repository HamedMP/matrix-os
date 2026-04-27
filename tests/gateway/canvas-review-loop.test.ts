import { describe, expect, it } from "vitest";
import { CanvasActionSchema } from "../../packages/gateway/src/canvas/contracts.js";

describe("canvas review loop actions", () => {
  it("validates provider-neutral review and PR actions", () => {
    for (const type of ["review.start", "review.stop", "review.next", "review.approve", "pr.refresh"] as const) {
      const parsed = CanvasActionSchema.parse({ nodeId: "node_review", type, payload: { round: 1 } });
      expect(parsed.payload).not.toHaveProperty("providerError");
    }
  });
});
