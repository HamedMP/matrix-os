import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CanonicalChatMessage } from "@matrix-os/contracts";
import { buildClaudeNativeReplayJsonl } from "../../packages/gateway/src/chat/claude-native-recovery-replay.js";

const receivedAtMs = Date.parse("2026-11-11T03:45:30.000Z");
const prompt = "Return the synthetic recovery marker";
const job = {
  id: "d20be289", cron: "* * * * *", recurring: true,
  promptSha256: createHash("sha256").update(prompt).digest("hex"),
  assistantUuid: "45305cdc-20ce-4fe0-aeb9-215db5070f6d",
  receiptUuid: "cff6255e-3216-49d6-a14d-bbd1dd40506f",
  replay: { toolUseId: "toolu_synthetic", assistantMessageId: "msg_synthetic",
    prompt, receivedAtMs, nextFireAtMs: receivedAtMs + 30_000.714 },
};
const scope = {
  sessionId: "48123484-1412-45e3-9576-93b6ff5b3c93",
  root: "/project",
  nowMs: receivedAtMs + 60_000,
  deadlineMs: receivedAtMs + 86_400_000,
};
const chatId = "chat_recovery_history";

function message(seq: number, role: CanonicalChatMessage["role"], parts: CanonicalChatMessage["parts"],
  overrides: Partial<CanonicalChatMessage> = {}): CanonicalChatMessage {
  return { id: `msg_recovery_${seq}`, chatId, seq, role, parts, state: "committed",
    createdAt: new Date(receivedAtMs + (seq - 2) * 1_000).toISOString(), ...overrides };
}

function textMessage(seq: number, role: CanonicalChatMessage["role"], text: string, overrides?: Partial<CanonicalChatMessage>) {
  return message(seq, role, [{ type: "text", text }], overrides);
}

function readRows(transcript: Buffer) {
  return transcript.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
}

describe("Claude native recovery replay", () => {
  it("emits only the two allowlisted records from one correlated receipt", () => {
    const untrustedExtra = { ...job, extras: "no", replay: { ...job.replay, rawMessage: "no" } };
    expect(() => buildClaudeNativeReplayJsonl({ ...scope, jobs: [untrustedExtra] })).toThrow("Native schedule replay unavailable");
    const transcript = buildClaudeNativeReplayJsonl({ ...scope, jobs: [job] }).toString("utf8");
    const prefix = { sessionId: scope.sessionId, cwd: scope.root, isSidechain: false, version: "2.1.317",
      userType: "external", timestamp: new Date(receivedAtMs).toISOString() };
    expect(transcript.endsWith("\n")).toBe(true);
    expect(transcript.trimEnd().split("\n").map(line => JSON.parse(line))).toEqual([
      { ...prefix, type: "assistant", uuid: job.assistantUuid, parentUuid: null, message: {
        id: "msg_synthetic", type: "message", role: "assistant",
        content: [{ type: "tool_use", id: "toolu_synthetic", name: "CronCreate",
          input: { cron: job.cron, prompt, recurring: true, durable: false } }],
      } },
      { ...prefix, type: "user", uuid: job.receiptUuid, parentUuid: job.assistantUuid,
        sourceToolAssistantUUID: job.assistantUuid, message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_synthetic", content: `Scheduled recurring job ${job.id}.` },
        ] },
        toolUseResult: { id: job.id, recurring: true, durable: false, nextFireAt: job.replay.nextFireAtMs } },
    ]);
  });

  const nextPrompt = "Return a second marker";
  const next = {
    ...job, id: "cafed001", promptSha256: createHash("sha256").update(nextPrompt).digest("hex"),
    assistantUuid: "21de53af-0378-4cfa-8134-716c3d54afc7", receiptUuid: "1e210f04-c541-4128-9b5a-c011e3081931",
    replay: { ...job.replay, toolUseId: "toolu_second", assistantMessageId: "msg_second", prompt: nextPrompt,
      receivedAtMs: receivedAtMs + 500 },
  };

  it("keeps two unrelated jobs in one ordered transcript chain", () => {
    const rows = buildClaudeNativeReplayJsonl({ ...scope, jobs: [next, job] }).toString("utf8").trimEnd()
      .split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => [row.uuid, row.parentUuid])).toEqual([
      [job.assistantUuid, null], [job.receiptUuid, job.assistantUuid],
      [next.assistantUuid, job.receiptUuid], [next.receiptUuid, next.assistantUuid],
    ]);
  });

  it.each([job.assistantUuid, next.assistantUuid])("restores two calls in one assistant message (%s)", assistantUuid => {
    const sibling = { ...next, assistantUuid, replay: { ...next.replay, assistantMessageId: job.replay.assistantMessageId } };
    const rows = readRows(buildClaudeNativeReplayJsonl({ ...scope, jobs: [sibling, job] }));
    expect(rows.map(row => [row.uuid, row.parentUuid])).toEqual([
      [job.assistantUuid, null], [job.receiptUuid, job.assistantUuid], [sibling.receiptUuid, job.receiptUuid],
    ]);
    expect(rows[0].message.content.map((block: { id: string }) => block.id)).toEqual([job.replay.toolUseId, sibling.replay.toolUseId]);
    expect(rows.slice(1).map(row => [row.sourceToolAssistantUUID, row.message.content[0].tool_use_id, row.toolUseResult.id])).toEqual(
      [job, sibling].map(item => [job.assistantUuid, item.replay.toolUseId, item.id]),
    );
    for (const invalid of [
      { ...sibling, receiptUuid: job.receiptUuid },
      { ...sibling, replay: { ...sibling.replay, toolUseId: job.replay.toolUseId } },
      { ...next, assistantUuid: job.assistantUuid },
      { ...sibling, assistantUuid: job.receiptUuid },
    ]) expect(() => buildClaudeNativeReplayJsonl({ ...scope, jobs: [job, invalid] })).toThrow("Native schedule replay unavailable");
  });

  it("preserves canonical roles and sequence around schedule receipts with stable native identifiers", () => {
    const historicalUser = textMessage(1, "user", "Prior user request");
    const historicalAssistant = textMessage(2, "assistant", "Prior assistant result");
    const laterUser = textMessage(3, "user", "Later canonical discussion", { createdAt: historicalUser.createdAt });
    const serialize = (messages: CanonicalChatMessage[]) => buildClaudeNativeReplayJsonl({
      ...scope, jobs: [job], history: { chatId, throughSeq: 3, messages },
    });
    const transcript = serialize([laterUser, historicalAssistant, historicalUser]);
    expect(transcript).toEqual(serialize([historicalUser, laterUser, historicalAssistant]));
    const rows = readRows(transcript);
    expect(rows.map(row => row.type)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(rows.map(row => row.message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(rows[0].message.content).toBe("Prior user request");
    expect(rows[1].uuid).toBe(job.assistantUuid);
    expect(rows[2].uuid).toBe(job.receiptUuid);
    expect(rows[3].message.content).toEqual([{ type: "text", text: "Prior assistant result" }]);
    expect(rows[4].message.content).toBe("Later canonical discussion");
    expect(rows[0].parentUuid).toBeNull();
    for (let index = 1; index < rows.length; index += 1) expect(rows[index].parentUuid).toBe(rows[index - 1].uuid);
    expect(new Set(rows.map(row => row.uuid)).size).toBe(rows.length);
  });

  it("skips pending, failed, non-chat, and post-boundary content and redacts credentials", () => {
    const transcript = buildClaudeNativeReplayJsonl({ ...scope, jobs: [job], history: {
      chatId, throughSeq: 6, messages: [
        message(1, "user", [
          { type: "text", text: "Prior owner context Bearer sensitive.token" },
          { type: "attachment_reference", attachmentId: "upload_other", kind: "file", label: "attachment-marker" },
        ]),
        message(2, "assistant", [
          { type: "text", text: "Saved context API_" },
          { type: "text", text: "KEY=secret-fragment" },
          { type: "tool_request", toolCallId: "tool_other", name: "Other tool", label: "old grant marker" },
        ]),
        textMessage(3, "assistant", "pending marker", { state: "pending" }),
        textMessage(4, "assistant", "failed marker", { state: "failed" }),
        textMessage(5, "system", "system marker"),
        textMessage(6, "tool", "old tool result marker"),
        textMessage(7, "assistant", "future marker"),
      ],
    } }).toString("utf8");
    expect(transcript).toContain("Prior owner context Bearer [redacted]");
    expect(transcript).toContain("Saved context [redacted credential]");
    expect(transcript).not.toMatch(/sensitive\.token|secret-fragment|attachment-marker|old grant marker|pending marker|failed marker|system marker|old tool result marker|future marker/);
  });

  it("keeps the newest context within the UTF-8 text budget", () => {
    const older = textMessage(1, "user", "Out of budget marker");
    const newer = textMessage(2, "assistant", "a" + "😀".repeat(4_000) + " recent");
    const rows = readRows(buildClaudeNativeReplayJsonl({ ...scope, jobs: [job],
      history: { chatId, throughSeq: 2, messages: [older, newer] } }));
    const text = rows.at(-1).message.content[0].text as string;
    expect(text).toMatch(/^😀+ recent$/u);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12_000);
    expect(rows).toHaveLength(3);
  });

  it("fails closed on foreign or ambiguous history and unbounded pages", () => {
    const owned = textMessage(1, "user", "Scoped content");
    for (const messages of [
      [owned, textMessage(2, "assistant", "Foreign content", { chatId: "chat_foreign" })],
      [owned, textMessage(1, "assistant", "Ambiguous sequence", { id: "msg_ambiguous" })],
      [owned, textMessage(2, "assistant", "Ambiguous id", { id: owned.id })],
      Array.from({ length: 41 }, (_, index) => textMessage(index + 1, "user", "Page exceeds limit")),
    ]) {
      expect(() => buildClaudeNativeReplayJsonl({ ...scope, jobs: [job],
        history: { chatId, throughSeq: 50, messages } })).toThrow("Native schedule replay unavailable");
    }
  });

  it.each([
    { id: "../job" },
    { recurring: false },
    { cron: "invalid cron" },
    { cron: "0 * * * * *" },
    { cron: "99 * * * *" },
    { assistantUuid: job.receiptUuid },
    { replay: undefined },
    { replay: { ...job.replay, prompt: "modified definition" } },
    { replay: { ...job.replay, toolUseId: "../tool" } },
    { replay: { ...job.replay, assistantMessageId: "" } },
    { replay: { ...job.replay, receivedAtMs: scope.nowMs + 1 } },
    { replay: { ...job.replay, nextFireAtMs: receivedAtMs - 100_000 } },
    { replay: { ...job.replay, nextFireAtMs: scope.deadlineMs + 1 } },
  ])("refuses corrupt or unqualified receipt %j", overrides => {
    expect(() => buildClaudeNativeReplayJsonl({ ...scope, jobs: [{ ...job, ...overrides }] })).toThrow("Native schedule replay unavailable");
  });

  it.each([
    { root: "relative/path" },
    { sessionId: "invalid-session" },
    { nowMs: scope.deadlineMs },
    { deadlineMs: receivedAtMs + 8 * 86_400_000 },
    { jobs: [job, { ...job, id: "cafed001" }] },
    { jobs: Array.from({ length: 51 }, () => job) },
  ])("refuses corrupt scope or ambiguous inventory %j", overrides => {
    expect(() => buildClaudeNativeReplayJsonl({ ...scope, jobs: [job], ...overrides })).toThrow("Native schedule replay unavailable");
  });
});
