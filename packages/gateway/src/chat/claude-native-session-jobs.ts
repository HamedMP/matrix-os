import { z } from "zod/v4";

export type NativeRecord = Record<string, unknown>;
export function nativeRecord(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NativeRecord : undefined;
}
export const nativeRef = z.string().min(1).max(256);
const CronCreate = z.object({ cron: z.string().min(1).max(256), prompt: z.string().min(1).max(16_000), recurring: z.boolean().optional() }).passthrough();
const CronDelete = z.object({ id: z.string().regex(/^[a-f0-9]{8}$/) }).passthrough();
interface Job { id: string; prompt: string; recurring: boolean }
interface Tool { name: string; input: unknown; authorizedPrompt?: string }
interface ObservedTool { name: string; sessionId?: string; parentId?: string; root: boolean; agentId?: string; command?: string }

/** Native receipts, never assistant prose, decide whether a child needs an owner. */
export function createClaudeNativeJobs() {
  const jobs = new Map<string, Job>(); // Native max50; delete/list/one-shot receipts remove entries.
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
    matches(prompt: string): Job | undefined {
      const matches = [...jobs.values()].filter(job => job.prompt === prompt);
      return matches.length === 1 ? matches[0] : undefined;
    },
    consume(job: Job) { if (!job.recurring) jobs.delete(job.id); },
    toolInput(toolId: string) { return tools.get(toolId); },
    authorizeCreate(toolId: string) {
      const tool = tools.get(toolId), parsed = CronCreate.safeParse(tool?.input);
      if (tool?.name !== "CronCreate" || tool.authorizedPrompt !== undefined || !parsed.success) return false;
      // UserPromptSubmit identifies a native task by prompt, not job ID. Reserve before effect,
      // including concurrent creates, so an ambiguous due callback never sacrifices an older job.
      const pending = [...tools.values()].filter(tool => tool.authorizedPrompt !== undefined);
      if (jobs.size + pending.length >= 50 || [...jobs.values()].some(job => job.prompt === parsed.data.prompt)
        || pending.some(tool => tool.authorizedPrompt === parsed.data.prompt)) return false;
      tool.authorizedPrompt = parsed.data.prompt;
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
          tools.set(id.data, { name: name.data, input: block.input });
        }
        if (frame.type !== "user" || frame.parent_tool_use_id != null || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const tool = tools.get(block.tool_use_id); tools.delete(block.tool_use_id);
        if (!tool || block.is_error === true || typeof block.content !== "string" || block.content.length > 65_536) continue;
        if (tool.name === "CronCreate") {
          const parsed = CronCreate.safeParse(tool.input);
          const id = /^Scheduled (?:recurring |one-shot )?(?:job|task) ([a-f0-9]{8})\b/.exec(block.content)?.[1];
          if (!parsed.success || !id || jobs.size >= 50) throw new Error("Native task receipt unavailable");
          jobs.set(id, { id, prompt: parsed.data.prompt, recurring: parsed.data.recurring ?? true });
        } else if (tool.name === "CronDelete") {
          const parsed = CronDelete.safeParse(tool.input);
          if (parsed.success && block.content === `Cancelled job ${parsed.data.id}.`) jobs.delete(parsed.data.id);
        } else if (tool.name === "CronList" && block.content === "No scheduled jobs.") jobs.clear();
      }
    },
  };
}
