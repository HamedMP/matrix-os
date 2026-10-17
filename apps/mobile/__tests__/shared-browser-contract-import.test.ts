import { SharedBrowserActionSchema, BrowserApprovalIntentSchema } from "@matrix-os/contracts";
import { BotToolRequestSchema } from "@matrix-os/contracts/bots";

describe("mobile shared Chrome contract imports", () => {
  it("loads browser actions through both the public contracts and bot request entrypoints", () => {
    const args = { action: "download", observationId: "obs_1", ref: "r1", documentId: "INV-001" };
    expect(SharedBrowserActionSchema.parse(args)).toEqual(args);
    expect(BotToolRequestSchema.parse({ toolCallId: "tool_1", capability: "browser.action", args }).args).toEqual(args);
  });

  it("loads supervised browser permission contracts through the public entrypoint", () => {
    expect(BrowserApprovalIntentSchema.parse({ kind: "shared_chrome", decision: "allow_once", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 }).decision).toBe("allow_once");
  });

  it("keeps arbitrary evaluation out of mobile bot browser requests", () => {
    const args = { action: "evaluate", script: "document.cookie" };
    expect(SharedBrowserActionSchema.safeParse(args).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({ toolCallId: "tool_1", capability: "browser.action", args }).success).toBe(false);
  });
});
