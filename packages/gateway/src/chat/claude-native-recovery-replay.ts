import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { CanonicalChatIdSchema, CanonicalChatMessageSchema, type CanonicalChatMessage } from "@matrix-os/contracts";
import cron from "node-cron";
import { z } from "zod/v4";
import { ClaudeNativeReplayInstant, ClaudeNativeScheduleReplaySchema } from "./claude-native-replay-receipt.js";
import type { ClaudeNativeScheduleEvidence } from "./claude-native-session-jobs.js";
import { redactAssistantCredentialParts, redactAssistantCredentials } from "./safe-activity-projection.js";
import { SESSION_HISTORY_BYTE_LIMIT, SESSION_HISTORY_MESSAGE_LIMIT } from "./session-history-limits.js";

const DAY_MS = 86_400_000;
const MAX_SESSION_MS = 7 * DAY_MS;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

const Job = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{8}$/),
  cron: z.string().max(256).regex(/^[!-~]+( +[!-~]+){4}$/).refine(value => cron.validate(value)),
  recurring: z.literal(true),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  assistantUuid: z.uuid(),
  receiptUuid: z.uuid(),
  replay: ClaudeNativeScheduleReplaySchema,
});

const History = z.strictObject({
  chatId: CanonicalChatIdSchema,
  throughSeq: z.int().nonnegative(),
  messages: z.array(CanonicalChatMessageSchema).max(SESSION_HISTORY_MESSAGE_LIMIT),
});

const Scope = z.strictObject({
  sessionId: z.uuid(),
  root: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0")),
  nowMs: ClaudeNativeReplayInstant,
  deadlineMs: ClaudeNativeReplayInstant,
  jobs: z.array(Job).min(1).max(50),
  history: History.optional(),
});

const unavailable = () => new Error("Native schedule replay unavailable");

function replayHistory({ chatId, throughSeq, messages }: z.infer<typeof History>) {
  const ids = new Set<string>();
  const seqs = new Set<number>();
  const selected: { id: string; seq: number; role: "user" | "assistant"; text: string; createdAt: number }[] = [];
  let remainingBytes = SESSION_HISTORY_BYTE_LIMIT;
  for (const message of messages.sort((left, right) => right.seq - left.seq)) {
    if (message.chatId !== chatId || ids.has(message.id) || seqs.has(message.seq)) throw unavailable();
    ids.add(message.id);
    seqs.add(message.seq);
    if (remainingBytes === 0 || message.seq > throughSeq || message.state !== "committed"
      || (message.role !== "user" && message.role !== "assistant")) continue;
    // Stored assistant chunks can split one credential across multiple text parts.
    const projected = redactAssistantCredentialParts(message.parts);
    const text = redactAssistantCredentials(projected.flatMap(part => part.type === "text" ? [part.text] : [])
      .join(message.role === "user" ? "\n" : ""));
    const encoded = Buffer.from(text, "utf8");
    let offset = Math.max(0, encoded.byteLength - remainingBytes);
    while (offset < encoded.byteLength && (encoded[offset]! & 0xc0) === 0x80) offset += 1;
    const suffix = encoded.subarray(offset).toString("utf8");
    if (suffix.trim()) {
      selected.push({ id: message.id, seq: message.seq, role: message.role, text: suffix, createdAt: Date.parse(message.createdAt) });
      remainingBytes -= encoded.byteLength - offset;
    }
    if (offset > 0) remainingBytes = 0;
  }
  return selected.reverse();
}

function canonicalMessageUuid(sessionId: string, chatId: string, messageId: string, seq: number) {
  const digest = createHash("sha256").update(JSON.stringify(["claude-native-recovery-history", sessionId, chatId, messageId, seq])).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Build a bounded transcript from authorized job receipts and the locked canonical Chat prefix. */
export function buildClaudeNativeReplayJsonl(input: {
  sessionId: string;
  root: string;
  nowMs: number;
  deadlineMs: number;
  jobs: readonly ClaudeNativeScheduleEvidence[];
  history?: { chatId: string; throughSeq: number; messages: readonly CanonicalChatMessage[] };
}): Buffer {
  const parsed = Scope.safeParse(input);
  if (!parsed.success) throw unavailable();
  const { sessionId, root, jobs, nowMs, deadlineMs, history } = parsed.data;
  if (nowMs >= deadlineMs) throw unavailable();

  const ids = new Set<string>();
  const digests = new Set<string>();
  const references = new Set<string>();
  const rows: string[] = [];
  let previous: string | null = null;
  let latestTimestamp = 0;
  let bytes = 0;
  const scope = (timestamp: number) => ({ sessionId, cwd: root, isSidechain: false, version: "2.1.317", userType: "external",
    timestamp: new Date(timestamp).toISOString() });
  const append = (record: { uuid: string; [key: string]: unknown }) => {
    const row = JSON.stringify({ ...record, parentUuid: previous }) + "\n";
    bytes += Buffer.byteLength(row);
    if (bytes > MAX_TRANSCRIPT_BYTES) throw unavailable();
    rows.push(row);
    previous = record.uuid;
  };
  function registerReference(ref: string) {
    if (references.has(ref)) throw unavailable();
    references.add(ref);
  }
  const orderedJobs = jobs.sort((a, b) => a.replay.receivedAtMs - b.replay.receivedAtMs || (a.id > b.id ? 1 : -1));
  const groups = new Map<string, (typeof jobs)[number][]>();
  const assistantMessages = new Map<string, string>();
  for (const job of orderedJobs) {
    const { prompt, receivedAtMs, nextFireAtMs, toolUseId, assistantMessageId } = job.replay;
    if (receivedAtMs > nowMs || deadlineMs - receivedAtMs > MAX_SESSION_MS || nextFireAtMs > deadlineMs
      || ids.has(job.id) || digests.has(job.promptSha256)
      || createHash("sha256").update(prompt).digest("hex") !== job.promptSha256) throw unavailable();
    ids.add(job.id);
    digests.add(job.promptSha256);
    registerReference(toolUseId);
    registerReference(job.receiptUuid.toLowerCase());
    // One native assistant message may be streamed as multiple frames with distinct UUIDs.
    const assistantUuid = job.assistantUuid.toLowerCase();
    if (assistantMessages.get(assistantUuid) !== assistantMessageId) {
      registerReference(assistantUuid);
      assistantMessages.set(assistantUuid, assistantMessageId);
    }
    const group = groups.get(assistantMessageId);
    if (group) group.push(job);
    else {
      registerReference(assistantMessageId);
      groups.set(assistantMessageId, [job]);
    }
  }

  function appendGroup(group: (typeof jobs)[number][]) {
    const { assistantUuid, replay } = group[0]!;
    append({ ...scope(Math.max(latestTimestamp, replay.receivedAtMs)), type: "assistant", uuid: assistantUuid,
      message: { id: replay.assistantMessageId, type: "message", role: "assistant", content: group.map(job => ({
        type: "tool_use", id: job.replay.toolUseId, name: "CronCreate",
        input: { cron: job.cron, prompt: job.replay.prompt, recurring: true, durable: false },
      })) } });
    for (const job of group) {
      const { receivedAtMs, toolUseId, nextFireAtMs } = job.replay;
      latestTimestamp = Math.max(latestTimestamp, receivedAtMs);
      append({ ...scope(latestTimestamp), type: "user", uuid: job.receiptUuid,
        sourceToolAssistantUUID: assistantUuid, message: { role: "user", content: [
          { type: "tool_result", tool_use_id: toolUseId, content: `Scheduled recurring job ${job.id}.` },
        ] }, toolUseResult: { id: job.id, recurring: true, durable: false, nextFireAt: nextFireAtMs } });
    }
  }

  const orderedGroups = [...groups.values()];
  let nextGroup = 0;
  if (history) {
    for (const message of replayHistory(history)) {
      const timestamp = Math.max(latestTimestamp, Math.min(message.createdAt, nowMs));
      // Canonical sequence determines causal order when persisted wall clocks differ.
      while (nextGroup < orderedGroups.length) {
        const group = orderedGroups[nextGroup]!;
        const receivedAt = group[0]!.replay.receivedAtMs;
        if (receivedAt > timestamp || (receivedAt === timestamp && message.role === "user")) break;
        appendGroup(group);
        nextGroup += 1;
      }
      latestTimestamp = Math.max(latestTimestamp, timestamp);
      const uuid = canonicalMessageUuid(sessionId, history.chatId, message.id, message.seq);
      registerReference(uuid);
      if (message.role === "user") {
        append({ ...scope(latestTimestamp), type: "user", uuid, message: { role: "user", content: message.text } });
      } else {
        const id = `msg_${uuid.replaceAll("-", "")}`;
        registerReference(id);
        append({ ...scope(latestTimestamp), type: "assistant", uuid, message: {
          id, type: "message", role: "assistant", content: [{ type: "text", text: message.text }],
        } });
      }
    }
  }
  while (nextGroup < orderedGroups.length) appendGroup(orderedGroups[nextGroup++]!);
  return Buffer.from(rows.join(""), "utf8");
}
