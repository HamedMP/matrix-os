import { expect, it } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
const create = { toolCallId: "call_rule", capability: "slack.rules", args: { operation: "create", sourceId: "slack_enrolled_12345678901234567890123456789012", ownerInstruction: "From now on summarize every new message immediately in English, focus on release risks.", definition: { trigger: "new_message", cadence: { kind: "immediate" }, focus: "release risks", language: "English" } } };
it("admits an explicit bounded standing Slack policy through the native broker contract", () => {
    expect(BotToolRequestSchema.safeParse(create).success).toBe(true);
});
it("requires an explicit cadence and rejects caller-supplied authority", () => {
    expect(BotToolRequestSchema.safeParse({ ...create, args: { ...create.args, ownerId: "another" } }).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({ ...create, args: { ...create.args, definition: { trigger: "new_message", focus: "risks", language: "English" } } }).success).toBe(false);
});
