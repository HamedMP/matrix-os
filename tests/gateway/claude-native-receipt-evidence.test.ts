import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeNativeJobs, parseClaudeNativeRestoreJobs } from "../../packages/gateway/src/chat/claude-native-session-jobs.js";

const assistantUuid = "45305cdc-20ce-4fe0-aeb9-215db5070f6d";
const receiptUuid = "cff6255e-3216-49d6-a14d-bbd1dd40506f";
const args = { cron: "0 0 * * *", prompt: "synthetic schedule", recurring: true };
const toolUseId = "toolu_synthetic";
const id = "d20be289";
const structured = { id, recurring: true, durable: false, nextFireAt: 1794357000000 };

function observed(messageId?: string) {
  const jobs = createClaudeNativeJobs();
  jobs.handle({ type: "assistant", uuid: assistantUuid, session_id: "native_1", parent_tool_use_id: null,
    message: { id: messageId, content: [{ type: "text", text: "exclude unrelated text" }, { type: "tool_use", id: toolUseId, name: "CronCreate", input: args }] } });
  return jobs;
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    type: "user", uuid: receiptUuid, session_id: "native_1", parent_tool_use_id: null,
    tool_use_result: structured,
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Scheduled recurring job ${id}. Session-only.` }] },
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("Claude live receipt evidence for recovery", () => {
  it("retains only the fields needed to replay an authorized root CronCreate", () => {
    const receivedAtMs = structured.nextFireAt - 60_000;
    const nextFireAtMs = structured.nextFireAt + 0.714;
    vi.useFakeTimers();
    vi.setSystemTime(receivedAtMs);
    const jobs = observed("msg_synthetic");
    expect(jobs.authorizeCreate(toolUseId)).toBe(true);
    jobs.handle(receipt({ timestamp: "forged timestamp", tool_use_result: { ...structured, nextFireAt: nextFireAtMs, unexpected: "exclude raw content" } }));
    expect(jobs.verifiedSnapshot()).toEqual([{
      id, cron: args.cron, recurring: true, assistantUuid, receiptUuid,
      promptSha256: createHash("sha256").update(args.prompt).digest("hex"),
      replay: { toolUseId, assistantMessageId: "msg_synthetic", prompt: args.prompt,
        receivedAtMs, nextFireAtMs },
    }]);
    jobs.verifiedSnapshot()[0]!.replay!.prompt = "modified snapshot";
    expect(jobs.verifiedSnapshot()[0]!.replay!.prompt).toBe(args.prompt);
    const evidence = jobs.verifiedSnapshot();
    const { assistantUuid: _assistantUuid, receiptUuid: _receiptUuid, replay: _replay, ...definition } = evidence[0]!;
    const restored = parseClaudeNativeRestoreJobs([definition], evidence);
    expect(createClaudeNativeJobs(restored.jobs, restored.evidence).verifiedSnapshot()).toEqual(evidence);
    evidence[0]!.replay!.prompt = "changed wire prompt";
    expect(() => parseClaudeNativeRestoreJobs([definition], evidence)).toThrow("Native idle recovery evidence unavailable");
  });

  it("does not make a contradictory recurring receipt replayable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(structured.nextFireAt - 60_000);
    const jobs = observed("msg_synthetic");
    expect(jobs.authorizeCreate(toolUseId)).toBe(true);
    jobs.handle(receipt({ message: { content: [
      { type: "tool_result", tool_use_id: toolUseId, content: `Scheduled one-shot job ${id}.` },
    ] } }));
    expect(jobs.verifiedSnapshot()[0]).not.toHaveProperty("replay");
  });

  it("keeps digest-only evidence when replay cannot validate message identity or timing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(structured.nextFireAt + 61_000);
    const badTime = observed("msg_synthetic");
    expect(badTime.authorizeCreate(toolUseId)).toBe(true);
    badTime.handle(receipt());
    expect(badTime.verifiedSnapshot()).toHaveLength(1);
    expect(badTime.verifiedSnapshot()[0]).not.toHaveProperty("replay");

    vi.setSystemTime(structured.nextFireAt - 60_000);
    const badIdentity = observed("../forged_message");
    expect(badIdentity.authorizeCreate(toolUseId)).toBe(true);
    badIdentity.handle(receipt());
    expect(badIdentity.verifiedSnapshot()).toHaveLength(1);
    expect(badIdentity.verifiedSnapshot()[0]).not.toHaveProperty("replay");
  });
  it("captures only canonical evidence, drops plaintext, and removes evidence on confirmed delete", () => {
    const jobs = observed();
    expect(jobs.authorizeCreate(toolUseId)).toBe(true);
    jobs.handle(receipt());
    expect(jobs.verifiedSnapshot()).toEqual([{
      id, cron: args.cron, recurring: true, assistantUuid, receiptUuid,
      promptSha256: createHash("sha256").update(args.prompt).digest("hex"),
    }]);
    jobs.handle({ type: "assistant", session_id: "native_1", parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "delete_tool", name: "CronDelete", input: { id } }] } });
    jobs.handle({ type: "user", session_id: "native_1", parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "delete_tool", content: `Cancelled job ${id}.` }] } });
    expect(jobs.verifiedSnapshot()).toEqual([]);
  });

  it("does not promote a text receipt without prior host authorization", () => {
    const jobs = observed();
    jobs.handle(receipt());
    expect(jobs.matches(args.prompt)).toBeDefined();
    expect(jobs.verifiedSnapshot()).toEqual([]);
  });

  it.each([
    { tool_use_result: undefined },
    { tool_use_result: { ...structured, id: "00000001" } },
    { tool_use_result: { ...structured, durable: true } },
    { tool_use_result: { ...structured, recurring: false } },
    { tool_use_result: { ...structured, nextFireAt: -1 } },
    { uuid: assistantUuid },
    { session_id: "unrelated" },
  ])("excludes incomplete, contradictory, and foreign structured receipts", (overrides) => {
    const jobs = observed();
    expect(jobs.authorizeCreate(toolUseId)).toBe(true);
    jobs.handle(receipt(overrides));
    expect(jobs.verifiedSnapshot()).toEqual([]);
  });
});
