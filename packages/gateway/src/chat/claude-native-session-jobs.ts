import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { ClaudeNativeReplayFireAt, ClaudeNativeReplayMessageId, ClaudeNativeScheduleReplaySchema,
  type ClaudeNativeScheduleReplay } from "./claude-native-replay-receipt.js";

export type NativeRecord = Record<string, unknown>;
export function nativeRecord(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NativeRecord : undefined;
}
export const nativeRef = z.string().min(1).max(256);
const CronCreate = z.object({
  cron: z.string().min(1).max(256),
  prompt: z.string().min(1).max(16_000),
  recurring: z.boolean().optional(),
  // Project-wide native jobs outlive the private Chat's authority.
  durable: z.literal(false).optional(),
}).passthrough();
const CronDelete = z.object({ id: z.string().regex(/^[a-f0-9]{8}$/) }).passthrough();
export const ClaudeNativeScheduleJobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{8}$/),
  cron: CronCreate.shape.cron,
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recurring: z.boolean(),
}).strict();
export type ClaudeNativeScheduleJob = z.infer<typeof ClaudeNativeScheduleJobSchema>;
export interface ClaudeNativeScheduleEvidence extends ClaudeNativeScheduleJob {
  assistantUuid: string;
  receiptUuid: string;
  replay?: ClaudeNativeScheduleReplay;
}
const RestoredJobs = z.array(ClaudeNativeScheduleJobSchema).min(1).max(50).refine(jobs =>
  new Set(jobs.map(job => job.id)).size === jobs.length
    && new Set(jobs.map(job => job.promptSha256)).size === jobs.length);
const RestoredEvidence = z.array(ClaudeNativeScheduleJobSchema.extend({
  assistantUuid: z.uuid(), receiptUuid: z.uuid(), replay: ClaudeNativeScheduleReplaySchema.optional(),
})).max(50);

export function parseClaudeNativeRestoreJobs(
  jobsValue: readonly ClaudeNativeScheduleJob[], evidenceValue?: readonly ClaudeNativeScheduleEvidence[],
) {
  const jobs = RestoredJobs.parse(jobsValue);
  const evidence = evidenceValue === undefined ? undefined : RestoredEvidence.parse(evidenceValue);
  if (evidence && (evidence.length !== jobs.length || jobs.some(job => {
    const matches = evidence.filter(item => item.id === job.id);
    const item = matches[0];
    return matches.length !== 1 || !item || item.cron !== job.cron
      || item.recurring !== job.recurring || item.promptSha256 !== job.promptSha256
      || (item.replay !== undefined && (!item.recurring || promptDigest(item.replay.prompt) !== item.promptSha256));
  }))) throw new Error("Native idle recovery evidence unavailable");
  return { jobs, evidence };
}

const StructuredCreateReceipt = z.object({
  id: ClaudeNativeScheduleJobSchema.shape.id,
  recurring: z.boolean(),
  durable: z.literal(false),
  nextFireAt: ClaudeNativeReplayFireAt,
});
const NativeUuid = z.uuid();
const promptDigest = (prompt: string) => createHash("sha256").update(prompt).digest("hex");
interface Tool {
  name: string;
  input: unknown;
  assistantUuid?: string;
  assistantMessageId?: string;
  sessionId?: string;
  authorized?: Omit<ClaudeNativeScheduleJob, "id">;
}
interface ObservedTool { name: string; sessionId?: string; parentId?: string; root: boolean; agentId?: string; command?: string }

/** Native receipts, never assistant prose, decide whether a child needs an owner. */
export function createClaudeNativeJobs(
  initial: readonly ClaudeNativeScheduleJob[] = [],
  initialEvidence: readonly ClaudeNativeScheduleEvidence[] = [],
) {
  // Native max50; delete/list/one-shot receipts remove entries.
  const jobs = new Map(initial.map(job => [job.id, job]));
  // Subset of jobs with a correlated authorization and receipt, including protected restore evidence.
  const copyEvidence = (job: ClaudeNativeScheduleEvidence): ClaudeNativeScheduleEvidence => ({
    ...job, ...(job.replay ? { replay: { ...job.replay } } : {}),
  });
  const verified = new Map(initialEvidence.map(job => [job.id, copyEvidence(job)]));
  const tools = new Map<string, Tool>(); // Max128 in-flight; each tool result removes its entry.
  const observed = new Map<string, ObservedTool>(); // Max512/LRU; cleared by beginPhase. Evicted callbacks fail closed.
  function observe(id: string, name: string, frame: NativeRecord, input?: unknown) {
    const session = nativeRef.safeParse(frame.session_id), parent = nativeRef.safeParse(frame.parent_tool_use_id);
    const previous = observed.get(id), command = nativeRecord(input)?.command;
    const proof: ObservedTool = { name, sessionId: session.success ? session.data : undefined, parentId: parent.success ? parent.data : undefined, root: frame.parent_tool_use_id === null };
    if (previous?.name === name && previous.sessionId === proof.sessionId && previous.parentId === proof.parentId && previous.root === proof.root) proof.agentId = previous.agentId;
    if (name === "Bash" && typeof command === "string" && command.length <= 40_000) proof.command = command;
    observed.delete(id);
    if (observed.size >= 512) observed.delete(observed.keys().next().value!);
    observed.set(id, proof);
  }
  function content(frame: NativeRecord): NativeRecord[] {
    const value = nativeRecord(frame.message)?.content;
    return Array.isArray(value) ? value.map(nativeRecord).filter((v): v is NativeRecord => v !== undefined) : [];
  }
  function rooted(id: string, sessionId: string) {
    for (let depth = 0; depth < 512; depth++) {
      const tool = observed.get(id); if (!tool || tool.sessionId !== sessionId) return false;
      if (tool.root) return true;
      const parent = tool.parentId ? observed.get(tool.parentId) : undefined;
      if (!parent || !parent.agentId || !["Agent", "Task"].includes(parent.name)) return false;
      id = tool.parentId!;
    }
    return false; // Missing ancestors, cycles and evicted roots never become new phase roots.
  }
  return {
    get size() { return jobs.size; },
    verifiedSnapshot() { return [...verified.values()].map(copyEvidence); },
    beginPhase() { tools.clear(); observed.clear(); },
    observes(toolId: string, name: string) { return observed.get(toolId)?.name === name; },
    acceptsFrame(frame: NativeRecord, sessionId: string) {
      if (frame.session_id !== sessionId) return false;
      if (frame.parent_tool_use_id === null) return true;
      const id = nativeRef.safeParse(frame.parent_tool_use_id), parent = id.success ? observed.get(id.data) : undefined;
      return id.success && !!parent?.agentId && ["Agent", "Task"].includes(parent.name) && rooted(id.data, sessionId);
    },
    ownsTool(toolId: string, name: string, sessionId: string, agentId?: string) {
      const tool = observed.get(toolId), parent = tool?.parentId ? observed.get(tool.parentId) : undefined;
      return tool?.name === name && rooted(toolId, sessionId) && (tool.root ? agentId === undefined : agentId !== undefined && parent?.agentId === agentId);
    },
    observesDelegatedBash(toolId: string, agentId: string, sessionId: string, input: unknown) {
      const tool = observed.get(toolId), parent = tool?.parentId ? observed.get(tool.parentId) : undefined;
      return rooted(toolId, sessionId) && tool?.name === "Bash" && tool.sessionId === sessionId && tool.command !== undefined && tool.command === nativeRecord(input)?.command
        && parent?.sessionId === sessionId && ["Agent", "Task"].includes(parent.name) && parent.agentId === agentId;
    },
    matches(prompt: string): ClaudeNativeScheduleJob | undefined {
      const digest = promptDigest(prompt);
      const matches = [...jobs.values()].filter(job => job.promptSha256 === digest);
      return matches.length === 1 ? matches[0] : undefined;
    },
    consume(job: ClaudeNativeScheduleJob) {
      if (!job.recurring) {
        jobs.delete(job.id);
        verified.delete(job.id);
      }
    },
    toolInput(toolId: string) { return tools.get(toolId); },
    authorizeCreate(toolId: string) {
      const tool = tools.get(toolId), parsed = CronCreate.safeParse(tool?.input);
      if (tool?.name !== "CronCreate" || tool.authorized || !parsed.success) return false;
      // UserPromptSubmit identifies a native task by prompt, not job ID. Reserve before effect,
      // including concurrent creates, so an ambiguous due callback never sacrifices an older job.
      const digest = promptDigest(parsed.data.prompt);
      const pending = [...tools.values()].filter(tool => tool.authorized);
      if (jobs.size + pending.length >= 50 || [...jobs.values()].some(job => job.promptSha256 === digest)
        || pending.some(tool => tool.authorized?.promptSha256 === digest)) return false;
      tool.authorized = { cron: parsed.data.cron, promptSha256: digest, recurring: parsed.data.recurring ?? true };
      return true;
    },
    handle(frame: NativeRecord) {
      if (frame.type === "system" && frame.subtype === "task_started" && frame.task_type === "local_agent") {
        const id = nativeRef.safeParse(frame.tool_use_id), agent = nativeRef.safeParse(frame.task_id), session = nativeRef.safeParse(frame.session_id);
        const parent = id.success ? observed.get(id.data) : undefined;
        if (id.success && parent && agent.success && session.success && rooted(id.data, session.data) && ["Agent", "Task"].includes(parent.name)) parent.agentId = agent.data;
      }
      const event = nativeRecord(frame.event), block = nativeRecord(event?.content_block);
      if (frame.type === "stream_event" && event?.type === "content_block_start" && block?.type === "tool_use") {
        const id = nativeRef.safeParse(block.id), name = nativeRef.safeParse(block.name);
        if (id.success && name.success) observe(id.data, name.data, frame);
      }
      for (const block of content(frame)) {
        if (frame.type === "assistant" && block.type === "tool_use") {
          const id = nativeRef.safeParse(block.id), name = nativeRef.safeParse(block.name);
          if (!id.success || !name.success) continue;
          observe(id.data, name.data, frame, block.input);
          if (!["CronCreate", "CronDelete", "CronList"].includes(name.data)) continue;
          if (frame.parent_tool_use_id != null) continue; // Delegation never receives native task ownership.
          if (tools.has(id.data)) continue; // Repeated assistant observations cannot erase an in-flight reservation.
          if (tools.size >= 128) throw new Error("Native task receipt limit exceeded");
          const uuid = NativeUuid.safeParse(frame.uuid), session = nativeRef.safeParse(frame.session_id);
          const messageId = ClaudeNativeReplayMessageId.safeParse(nativeRecord(frame.message)?.id);
          tools.set(id.data, {
            name: name.data, input: block.input,
            ...(frame.parent_tool_use_id === null && uuid.success && session.success ? {
              assistantUuid: uuid.data, sessionId: session.data,
              ...(messageId.success ? { assistantMessageId: messageId.data } : {}),
            } : {}),
          });
        }
        if (frame.type !== "user" || frame.parent_tool_use_id != null || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const tool = tools.get(block.tool_use_id); tools.delete(block.tool_use_id);
        if (!tool || block.is_error === true || typeof block.content !== "string" || block.content.length > 65_536) continue;
        if (tool.name === "CronCreate") {
          const parsed = CronCreate.safeParse(tool.input);
          const id = /^Scheduled (?:recurring |one-shot )?job ([a-f0-9]{8})\b/.exec(block.content)?.[1];
          if (!parsed.success || !id || jobs.size >= 50) throw new Error("Native task receipt unavailable");
          const job = { id, cron: parsed.data.cron, promptSha256: promptDigest(parsed.data.prompt), recurring: parsed.data.recurring ?? true };
          const newId = !jobs.has(id);
          jobs.set(id, job);
          verified.delete(id);
          const receipt = StructuredCreateReceipt.safeParse(frame.tool_use_result);
          const uuid = NativeUuid.safeParse(frame.uuid);
          if (frame.parent_tool_use_id === null && tool.assistantUuid && tool.sessionId === frame.session_id
            && uuid.success && uuid.data !== tool.assistantUuid
            && receipt.success && receipt.data.id === id && receipt.data.recurring === job.recurring
            && tool.authorized?.cron === job.cron && tool.authorized.promptSha256 === job.promptSha256
            && tool.authorized.recurring === job.recurring) {
            const replay = ClaudeNativeScheduleReplaySchema.safeParse({
              toolUseId: block.tool_use_id, assistantMessageId: tool.assistantMessageId,
              prompt: parsed.data.prompt, receivedAtMs: Date.now(), nextFireAtMs: receipt.data.nextFireAt,
            });
            verified.set(id, { ...job, assistantUuid: tool.assistantUuid, receiptUuid: uuid.data,
              ...(newId && job.recurring && block.content.startsWith("Scheduled recurring job ") && replay.success
                ? { replay: replay.data } : {}),
            });
          }
        } else if (tool.name === "CronDelete") {
          const parsed = CronDelete.safeParse(tool.input);
          if (parsed.success && block.content === `Cancelled job ${parsed.data.id}.`) {
            jobs.delete(parsed.data.id);
            verified.delete(parsed.data.id);
          }
        } else if (tool.name === "CronList" && block.content === "No scheduled jobs.") {
          jobs.clear();
          verified.clear();
        }
      }
    },
  };
}
