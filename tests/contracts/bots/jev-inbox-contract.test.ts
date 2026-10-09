import { describe, expect, it } from "vitest";
import { BotToolRequestSchema, BotEffectListSchema, BotInteractionPayloadSchema, botIntegrationAccessCopy } from "@matrix-os/contracts";

const receipt = "a".repeat(64);
const jobId = `jev_batch_${"a".repeat(32)}`;
const request = (args: unknown) => BotToolRequestSchema.safeParse({ toolCallId: "call_jev", capability: "jev.inbox", args });

describe("task-bound Jev inbox broker contract", () => {
  it("allows a disclosed add-label grant without generic Gmail write authority", () => {
    expect(BotEffectListSchema.safeParse(["read", "label"]).success).toBe(true);
    const choice = BotInteractionPayloadSchema.safeParse({ kind: "account_choice", service: "gmail",
      access: ["read", "label"], options: [{ connectionId: "conn_gmail", label: "My Gmail" }] });
    expect(choice.success).toBe(true);
    expect(BotEffectListSchema.safeParse(["label", "label"]).success).toBe(false);
  });
  it("does not understate broader existing account authority in disclosure", () => {
    expect(botIntegrationAccessCopy("gmail", ["read", "label"]).boundary).toMatch(/no archive/);
    expect(botIntegrationAccessCopy("gmail", ["read", "label", "write"]).boundary).toBeNull();
    expect(botIntegrationAccessCopy("gmail", ["read", "label", "send"]).summary).toContain("send");
    expect(botIntegrationAccessCopy("gmail", ["read"]).summary).toBe("read");
  });
  it.each([
    { operation: "discover" }, { operation: "select", receipt, threadId: "abcdef012345" },
    { operation: "evaluate", receipt }, { operation: "batch_start", maxThreads: 10000 },
    { operation: "batch_next", jobId, revision: 1 }, { operation: "batch_resume", jobId },
    { operation: "batch_status" }, { operation: "batch_status", jobId },
  ])("accepts an existing scoped operation: %j", (args) => { expect(request(args).success).toBe(true); });

  it.each([
    { operation: "discover", ownerId: "another-owner" },
    { operation: "batch_start", threadIds: ["forged"] },
    { operation: "evaluate", receipt, verified: true, labels: ["INBOX"] },
    { operation: "archive", threadId: "abcdef012345" },
    { operation: "batch_start", maxThreads: 10001 },
    { operation: "select", receipt: "forged", threadId: "abcdef012345" },
    { operation: "batch_next", jobId: "forged", revision: 1 },
    { operation: "batch_next", jobId, revision: 0 },
  ])("rejects authority injection or invalid operations: %j", (args) => { expect(request(args).success).toBe(false); });
});
