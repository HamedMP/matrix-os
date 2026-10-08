import { describe, expect, it } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";

const receipt = "a".repeat(64);
const jobId = `jev_batch_${"a".repeat(32)}`;
const request = (args: unknown) => BotToolRequestSchema.safeParse({ toolCallId: "call_jev", capability: "jev.inbox", args });

describe("task-bound Jev inbox broker contract", () => {
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
