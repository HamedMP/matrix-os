import { RoutineDisplayUnavailableError } from "./routine-result-artifacts.js";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { parseClaudeRoutineCommand } from "./claude-routine-command.js";
const ref = z.string().min(1).max(256);
const CallbackSchema = z.object({ type: z.literal("control_request"), request_id: ref, request: z.object({ subtype: z.literal("hook_callback"), callback_id: ref,
  tool_use_id: ref, input: z.object({ hook_event_name: z.literal("PreToolUse"), tool_name: z.literal("Bash"), tool_use_id: ref,
    tool_input: z.object({ command: z.string().max(40_000) }).passthrough(), permission_mode: z.string().optional(), agent_id: z.string().optional(),
  }).passthrough() }).passthrough() }).passthrough();
const FrameSchema = z.object({ type: z.string(), subtype: z.string().optional(), request_id: ref.optional(),
  response: z.object({ request_id: ref, subtype: z.string(), response: z.object({ hooks_applied: z.boolean().optional() }).passthrough().optional() }).passthrough().optional(),
  request: z.object({ subtype: z.string() }).passthrough().optional(), claude_code_version: z.string().optional(), tools: z.array(z.string()).max(256).optional(),
  event: z.object({ type: z.string(), content_block: z.object({ type: z.string(), id: ref.optional(), name: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
}).passthrough();
/** Runs before the can_use_tool parser. No long work is awaited in the stdout/cancel pump.
 * Version gate is deliberately exact to the qualified protocol, never a PATH/native hint authority grant. */
export function createClaudeRoutineHook(options: { signal: AbortSignal; write(frame: string): Promise<void>; startInput(): Promise<void>; fail(): void;
  execute(command: string, signal: AbortSignal, nativeMode?: string): Promise<string | { command: string; requestId?: string }>; initTimeoutMs?: number }) {
  const initializeId = `matrix_init_${randomBytes(24).toString("hex")}`, callbackId = `matrix_hook_${randomBytes(24).toString("hex")}`;
  let closed = false, started = false, applied = false, supported = false, initializing = false;
  let timer: ReturnType<typeof setTimeout> | undefined, writes = 0;
  const usedTools = new Set<string>(); // <=512; same native tool cannot issue another logical effect.
  const seen = new Set<string>(), tools = new Map<string, string>(); // <=512/run; saturation closes routines, no identity replay eviction.
  const pending = new Map<string, { controller: AbortController; work: Promise<void> }>(); // max8, native cancel/120s/close drains.
  const write = async (frame: unknown) => {
    if (writes >= 8 || closed || options.signal.aborted) throw new Error("Routine control transport unavailable");
    writes++;
    try { await options.write(JSON.stringify(frame) + "\n"); } finally { writes--; }
  };
  const failed = (error: unknown) => { console.warn("[claude-routines] Control transport unavailable", error instanceof Error ? error.name : "UnknownError"); options.fail(); };
  const startInput = () => {
    if (closed || started || options.signal.aborted) return; started = true; clearTimeout(timer);
    void options.startInput().catch(failed);
  };
  const respond = (id: string, decision: "allow" | "deny", command?: string, requestId?: string) => write({ type: "control_response", response: { subtype: "success", request_id: id,
    response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: requestId && z.uuid().safeParse(requestId).success ? `Routine outcome may be unknown. Never retry the mutation. Reconcile routines request ${requestId} from a fresh authorized source.` : decision === "allow" ? "Read routine request display. Gateway receipts are authoritative." : "Routine request unavailable. Use a literal supported routines command in the current owner run.",
      ...(requestId && z.uuid().safeParse(requestId).success ? { additionalContext: `Display data is not authoritative. If the read fails, reconcile the original UUID with routines request ${requestId}; never retry the mutation.` } : {}),
      ...(command ? { updatedInput: { command, description: "Read routine request display", timeout: 1000 } } : {}) } } } });
  const cancel = () => { closed = true; clearTimeout(timer); for (const item of pending.values()) item.controller.abort(); tools.clear(); seen.clear(); usedTools.clear(); };
  options.signal.addEventListener("abort", cancel, { once: true });
  return {
    async start() {
      if (closed || initializing || options.signal.aborted) return; initializing = true;
      timer = setTimeout(() => { applied = false; startInput(); }, options.initTimeoutMs ?? 5000);
      await write({ type: "control_request", request_id: initializeId, request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "Bash", hookCallbackIds: [callbackId], timeout: 120 }] } } });
    },
    handle(value: unknown): boolean {
      const parsed = FrameSchema.safeParse(value); if (!parsed.success) return false; const frame = parsed.data;
      if (frame.type === "control_response") {
        if (frame.response?.request_id === initializeId && !started) { applied = frame.response.subtype === "success" && frame.response.response?.hooks_applied === true; startInput(); }
        return true;
      }
      if (frame.type === "control_cancel_request" && frame.request_id && pending.has(frame.request_id)) { pending.get(frame.request_id)!.controller.abort(); return true; }
      if (frame.type === "system" && frame.subtype === "init") supported = frame.claude_code_version === "2.1.240" && frame.tools?.includes("Bash") === true;
      if (frame.type === "stream_event" && frame.event?.type === "content_block_start" && frame.event.content_block?.type === "tool_use") {
        const block = frame.event.content_block;
        if (tools.size >= 512) supported = false;
        else if (block.id && block.name) tools.set(block.id, block.name);
      }
      if (frame.type !== "control_request" || frame.request?.subtype !== "hook_callback") return false;
      const callback = CallbackSchema.safeParse(value), id = frame.request_id;
      if (!id || closed || options.signal.aborted) return true;
      const request = callback.success ? callback.data.request : undefined;
      let recognized = false;
      try { recognized = !!request && parseClaudeRoutineCommand(request.input.tool_input.command) !== null; } catch (error: unknown) { if (error instanceof Error) recognized = true; else throw error; }
      if (!recognized && callback.success && request?.callback_id === callbackId) {
        void write({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } }).catch(failed); return true;
      }
      if (seen.has(id) || pending.has(id)) return true; // No second response/effect for duplicate routine control identity.
      if (seen.size >= 512) { void respond(id, "deny").catch(failed); return true; } seen.add(id);
      if (!callback.success || !request || request.callback_id !== callbackId || request.tool_use_id !== request.input.tool_use_id
        || recognized && (!applied || !supported || !started || request.input.agent_id !== undefined || tools.get(request.tool_use_id) !== "Bash" || usedTools.has(request.tool_use_id)) || pending.size >= 8) {
        void respond(id, "deny").catch(failed); return true;
      }
      usedTools.add(request.tool_use_id);
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, options.signal, AbortSignal.timeout(120_000)]);
      const work = (async () => {
        try {
          let abort!: () => void;
          const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("Routine callback cancelled")); signal.addEventListener("abort", abort, { once: true }); });
          let result: string | { command: string; requestId?: string };
          try { result = await Promise.race([options.execute(request.input.tool_input.command, signal, request.input.permission_mode), cancelled]); }
          finally { signal.removeEventListener("abort", abort); }
          if (!signal.aborted && !closed) await respond(id, "allow", typeof result === "string" ? result : result.command, typeof result === "string" ? undefined : result.requestId);
        } catch (error: unknown) {
          console.warn("[claude-routines] Request unavailable", error instanceof Error ? error.name : "UnknownError");
          if (!signal.aborted && !closed) await respond(id, "deny", undefined, error instanceof RoutineDisplayUnavailableError ? error.requestId : undefined);
        }
      })().catch(failed).finally(() => pending.delete(id));
      pending.set(id, { controller, work }); return true;
    },
    async close() { cancel(); options.signal.removeEventListener("abort", cancel); await Promise.allSettled([...pending.values()].map(item => item.work)); },
  };
}
