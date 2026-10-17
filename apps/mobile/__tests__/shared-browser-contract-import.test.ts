import { SharedBrowserActionSchema } from "@matrix-os/contracts";
import { BotToolRequestSchema } from "@matrix-os/contracts/bots";

describe("mobile shared Chrome contract imports", () => {
  it("loads browser actions through both the public contracts and bot request entrypoints", () => {
    const args = { action: "download", observationId: "obs_1", ref: "r1", documentId: "INV-001" };
    expect(SharedBrowserActionSchema.parse(args)).toEqual(args);
    expect(BotToolRequestSchema.parse({ toolCallId: "tool_1", capability: "browser.action", args }).args).toEqual(args);
  });

  it("keeps arbitrary evaluation out of mobile bot browser requests", () => {
    const args = { action: "evaluate", script: "document.cookie" };
    expect(SharedBrowserActionSchema.safeParse(args).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({ toolCallId: "tool_1", capability: "browser.action", args }).success).toBe(false);
  });
});
