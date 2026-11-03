import { z } from "zod/v4";
import { spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";
import { createBoundedCliLines } from "./bounded-cli-lines.js";
import { CanonicalCliError, type CanonicalCliProcess, type runCanonicalCli } from "./cli-process.js";
import type { CanonicalProviderRunInput } from "./provider-adapter.js";
import type { NativeScheduledPhaseRequest } from "./native-scheduled-admission.js";
import { createClaudeNativeJobs, nativeRecord, nativeRef, type NativeRecord } from "./claude-native-session-jobs.js";
import { createClaudeNativeSessionControl, nativePhaseMcpServers, type NativeSessionControl } from "./claude-native-session-control.js";

export type ClaudeNativeSessionTurnOptions = Parameters<typeof runCanonicalCli>[0] & {
  input: CanonicalProviderRunInput;
  /** Current account/source/root/model/permission fingerprint; never a scoped Run token. */
  sourceFingerprint: string;
  schedulingAllowed?: boolean;
};
type ScheduledHandler = (request: NativeScheduledPhaseRequest) => Promise<void>;
interface PoolOptions {
  protocolQualified?: boolean;
  onScheduledPhase?: ScheduledHandler;
  maxSessions?: number;
  maxSessionsPerOwner?: number;
  maxSessionMs?: number;
  controlTimeoutMs?: number;
}
interface Phase {
  options: ClaudeNativeSessionTurnOptions;
  resolve(): void; reject(error: Error): void;
  abort(): void;
  expectedPrompt?: string;
  promptId?: string;
  result: boolean;
  ending: boolean;
  prepare?: Promise<void>;
  idlePaused: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  startupTimer?: ReturnType<typeof setTimeout>;
  stderrBytes: number;
}
interface HeldPrompt { id: string; promptId: string; prompt: string; timer: ReturnType<typeof setTimeout> }
const MAX_SESSION_MS = 7 * 24 * 60 * 60_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const PromptInput = z.object({ hook_event_name: z.literal("UserPromptSubmit"), session_id: nativeRef, prompt_id: nativeRef,
  prompt: z.string().min(1).max(128 * 1024), agent_id: z.undefined().optional() }).passthrough();
const ToolInput = z.object({ hook_event_name: z.literal("PreToolUse"), session_id: nativeRef, prompt_id: nativeRef,
  tool_name: nativeRef, tool_use_id: nativeRef, tool_input: z.unknown(), agent_id: nativeRef.optional() }).passthrough();
const ScheduledWakeupStatus = z.object({ type: z.literal("command_lifecycle"), command_uuid: z.uuid(),
  state: z.literal("started"), wakeup_source: z.literal("schedule_wakeup"), uuid: z.uuid(), session_id: nativeRef }).strict();
const ScheduledCompletionStatus = z.object({ type: z.literal("command_lifecycle"), command_uuid: z.uuid(),
  state: z.literal("completed"), uuid: z.uuid(), session_id: nativeRef }).strict();
function reportNativeSessionFailure(error: unknown) {
  console.warn("[claude-native] Native session operation unavailable", error instanceof Error ? error.name : "UnknownError");
}
const sessionKey = (input: Pick<CanonicalProviderRunInput, "owner" | "chatId">) => JSON.stringify([input.owner.type, input.owner.ownerId, input.chatId]);

/** Owns a physical native child separately from each canonical Run. It never schedules a prompt. */
export function createClaudeNativeSessionPool(options: PoolOptions = {}) {
  const sessions = new Map<string, Session>(); // Max160 physical children; actual close removes. Live children are never evicted.
  const maxSessions = options.maxSessions ?? 32, perOwner = options.maxSessionsPerOwner ?? 8;
  const lifetime = options.maxSessionMs ?? MAX_SESSION_MS, controlMs = options.controlTimeoutMs ?? 10_000;
  for (const [value, maximum] of [[maxSessions, 128], [perOwner, 128], [lifetime, MAX_SESSION_MS], [controlMs, 30_000]]) {
    if (!Number.isInteger(value) || value! < 1 || value! > maximum!) throw new RangeError("Invalid native session limit");
  }
  let handler = options.onScheduledPhase, closing = false;
  const capacity = (candidate: Session) => {
    const retained = [...sessions.values()].filter(s => s !== candidate && (s.jobs.size > 0 || s.reserved));
    return retained.length < maxSessions && retained.filter(s => s.ownerKey === candidate.ownerKey).length < perOwner;
  };

  class Session {
    readonly ownerKey: string;
    readonly jobs = createClaudeNativeJobs();
    readonly child: CanonicalCliProcess;
    readonly key: string;
    readonly fingerprint: string;
    readonly control: NativeSessionControl;
    readonly closed: Promise<void>;
    phase?: Phase;
    lastInput: CanonicalProviderRunInput;
    private lastSchedulingAllowed: boolean;
    sessionId?: string;
    private scheduledCommandId?: string; // One observed native wakeup, cleared on its completion; never authorizes a Run.
    initFrame?: NativeRecord;
    reserved = false;
    stopped = false;
    physicalClosed = false;
    private resolveClosed!: () => void;
    private rejectClosed!: (error: Error) => void;
    private termination?: Error;
    private writes = 0;
    private deadline: number;
    private absoluteTimer?: ReturnType<typeof setTimeout>;
    private forceTimer?: ReturnType<typeof setTimeout>;
    private confirmTimer?: ReturnType<typeof setTimeout>;
    private pendingPrompt?: HeldPrompt;
    private readonly prompts = new Set<string>(); // Max4096/native child; saturation stops the child instead of evicting replay evidence.
    private readonly wireIds = new Set<string>(); // Max4096 callback IDs; saturation stops the child.
    constructor(readonly initial: ClaudeNativeSessionTurnOptions) {
      this.key = sessionKey(initial.input); this.ownerKey = JSON.stringify(initial.input.owner);
      this.fingerprint = initial.sourceFingerprint; this.lastInput = initial.input; this.lastSchedulingAllowed = initial.schedulingAllowed !== false;
      this.deadline = Date.now() + Math.min(lifetime, initial.timeoutMs ?? lifetime);
      this.closed = new Promise<void>((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
      void this.closed.catch(reportNativeSessionFailure);
      const spawnArgs = initial.args.filter((_arg, index, args) => args[index] !== "--mcp-config" && args[index - 1] !== "--mcp-config");
      this.child = (initial.spawnFn ?? ((command, args, spawnOptions) => spawnIsolatedProviderProcess(command, args, spawnOptions)))(initial.command, spawnArgs, {
        cwd: initial.cwd, env: initial.replaceEnv ? initial.env : { ...process.env, ...initial.env } as Record<string, string>, stdio: ["pipe", "pipe", "pipe"],
      });
      this.control = createClaudeNativeSessionControl({ send: frame => this.send(frame), emit: frame => this.deliver(frame), timeoutMs: controlMs });
      this.child.stdin?.on?.("error", () => { void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); });
      const lines = createBoundedCliLines(Math.min(MAX_FRAME_BYTES, initial.maxStdoutBytes), raw => {
        const frame = nativeRecord(JSON.parse(raw)); if (!frame || typeof frame.type !== "string") throw new Error("Native frame unavailable");
        this.frame(frame);
      });
      this.child.stdout.on("data", chunk => { if (!this.stopped) try { lines.push(chunk); } catch (error: unknown) { void this.stop(new CanonicalCliError("invalid_output")).catch(reportNativeSessionFailure); } });
      this.child.stderr.on("data", chunk => {
        const phase = this.phase; if (!phase) return;
        const bounded = chunk.subarray(0, Math.max(0, (phase.options.maxStderrBytes ?? 8192) - phase.stderrBytes));
        phase.stderrBytes += bounded.byteLength;
        if (bounded.byteLength) try { phase.options.onStderr?.(bounded); }
        catch (error: unknown) { console.warn("[claude-native] Stderr observer unavailable", error instanceof Error ? error.name : "UnknownError"); }
      });
      this.child.once("error", () => { void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); });
      let exitError: Error | undefined;
      this.child.once("exit", (code, signal) => { exitError = code === 0 && signal === null ? undefined : new CanonicalCliError("exit", code, signal); });
      // Native ChildProcess emits close after stdout/stderr drain. An absent close never proves cleanup.
      const closer = this.child as CanonicalCliProcess & { once(event: "close", listener: () => void): void };
      closer.once("close", () => {
        if (this.physicalClosed) return; this.physicalClosed = true;
        if (!this.stopped) try { lines.finish(); } catch (error: unknown) { exitError = new CanonicalCliError("invalid_output"); }
        this.stopped = true; this.clearTimers(); this.control.close();
        if (sessions.get(this.key) === this) sessions.delete(this.key);
        this.finishPhase(this.termination ?? exitError);
        this.lastInput.onCleanupConfirmed?.(); this.resolveClosed();
      });
      this.resetDeadline();
    }
    eligible() {
      const input = this.phase?.options.input ?? this.lastInput;
      return options.protocolQualified === true && !!handler && this.control.qualified
        && (this.phase ? this.phase.options.schedulingAllowed !== false : this.lastSchedulingAllowed) && input.owner.type === "personal"
        && input.interactionMode === "default" && !input.sharedScopeId && !input.context?.agent;
    }
    private resetDeadline() {
      clearTimeout(this.absoluteTimer);
      this.absoluteTimer = setTimeout(() => { void this.stop(new CanonicalCliError("timeout")).catch(reportNativeSessionFailure); }, Math.max(1, this.deadline - Date.now())); this.absoluteTimer.unref?.();
    }
    private clearTimers() {
      clearTimeout(this.absoluteTimer); clearTimeout(this.forceTimer); clearTimeout(this.confirmTimer);
      if (this.pendingPrompt) clearTimeout(this.pendingPrompt.timer); this.pendingPrompt = undefined;
    }
    private async send(value: unknown) {
      const frame = JSON.stringify(value) + "\n";
      if (this.stopped || Buffer.byteLength(frame) > MAX_FRAME_BYTES || !this.child.stdin) throw new CanonicalCliError("startup");
      if (this.writes >= 16) { void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); throw new Error("Native write limit exceeded"); }
      this.writes++;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new CanonicalCliError("timeout")), controlMs); timer.unref?.();
          try { this.child.stdin!.write(frame, error => { clearTimeout(timer); if (error) reject(error); else resolve(); }); }
          catch (error: unknown) { clearTimeout(timer); reject(error); }
        });
      } catch (error: unknown) { void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); throw error; }
      finally { this.writes--; }
    }
    private deliver(frame: NativeRecord) {
      const phase = this.phase; if (!phase || this.stopped) return;
      this.touch(phase); phase.options.onStdout(Buffer.from(JSON.stringify(frame) + "\n"));
    }
    private touch(phase: Phase) {
      clearTimeout(phase.idleTimer);
      if (phase.options.idleTimeoutMs !== undefined && !phase.idlePaused) {
        phase.idleTimer = setTimeout(() => { void this.stop(new CanonicalCliError("timeout")).catch(reportNativeSessionFailure); }, phase.options.idleTimeoutMs); phase.idleTimer.unref?.();
      }
    }
    private finishPhase(error?: Error) {
      const phase = this.phase; if (!phase) return;
      this.phase = undefined; this.lastInput = phase.options.input; this.lastSchedulingAllowed = phase.options.schedulingAllowed !== false;
      clearTimeout(phase.idleTimer); clearTimeout(phase.startupTimer); phase.options.signal.removeEventListener("abort", phase.abort);
      try { phase.options.onSettled?.(); } catch (error: unknown) { console.warn("[claude-native] Phase settlement unavailable", error instanceof Error ? error.name : "UnknownError"); }
      if (error) phase.reject(error); else phase.resolve();
    }
    private endPhase() {
      const phase = this.phase; if (!phase || phase.ending) return; phase.ending = true;
      if (phase.result && this.jobs.size > 0 && this.eligible() && capacity(this)) { this.reserved = true; this.finishPhase(); return; }
      this.child.stdin?.end?.();
    }
    bind(turn: ClaudeNativeSessionTurnOptions): Promise<void> {
      if (this.phase || this.stopped) throw new Error("Native session busy");
      const scheduled = turn.input.nativeScheduled;
      if (scheduled && (!this.pendingPrompt || scheduled.promptId !== this.pendingPrompt.promptId || scheduled.sessionId !== this.sessionId
        || scheduled.sourceRunId !== this.lastInput.runId)) throw new Error("Native scheduled phase unavailable");
      if (!scheduled && this.pendingPrompt) throw new Error("Native session has a pending scheduled phase");
      this.lastInput = turn.input; this.jobs.beginPhase(); this.control.beginPhase();
      this.deadline = Math.min(this.deadline, Date.now() + (turn.timeoutMs ?? lifetime)); this.resetDeadline();
      return new Promise<void>((resolve, reject) => {
        const phase: Phase = { options: turn, resolve, reject, abort: () => { void this.stop(new CanonicalCliError("aborted")).catch(reportNativeSessionFailure); }, result: false, ending: false, idlePaused: false, stderrBytes: 0 };
        this.phase = phase;
        turn.signal.addEventListener("abort", phase.abort, { once: true }); if (turn.signal.aborted) { phase.abort(); return; }
        this.touch(phase);
        if (turn.startupTimeoutMs !== undefined) { phase.startupTimer = setTimeout(() => { void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); }, turn.startupTimeoutMs); phase.startupTimer.unref?.(); }
        // This is the actual immutable init observation from this same held native child, not a new process proof.
        if (this.initFrame) this.deliver(this.initFrame);
        const prepare = () => phase.prepare ??= this.control.prepare(nativePhaseMcpServers(turn.args, turn.env));
        const write = async (raw: string) => {
          const frame = nativeRecord(JSON.parse(raw)); if (!frame || this.phase !== phase || this.stopped) throw new Error("Native phase transport unavailable");
          const request = nativeRecord(frame.request);
          if (frame.type === "control_request" && request?.subtype === "initialize") {
            phase.prepare = this.control.registerPhase(frame, nativePhaseMcpServers(turn.args, turn.env));
            try { await phase.prepare; } catch (error: unknown) { void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); throw error; } return;
          }
          if (frame.type !== "user") { await this.send(frame); return; }
          await prepare(); if (this.phase !== phase || this.stopped) throw new Error("Native phase expired");
          if (scheduled) {
            const held = this.pendingPrompt; if (!held || held.promptId !== scheduled.promptId) throw new Error("Native scheduled phase expired");
            clearTimeout(held.timer); this.pendingPrompt = undefined; phase.promptId = held.promptId;
            await this.control.respond(held.id, {}); // Native already owns the due prompt. Never write a replay user frame.
          } else {
            const message = nativeRecord(frame.message); if (typeof message?.content !== "string") throw new Error("Native initial prompt unavailable");
            phase.expectedPrompt = message.content; await this.send(frame);
          }
        };
        const managedWrite = (raw: string) => write(raw).catch((error: unknown) => {
          void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); throw error;
        });
        try { turn.onStart?.(managedWrite, () => this.endPhase(), { pause: () => { phase.idlePaused = true; clearTimeout(phase.idleTimer); }, resume: () => { phase.idlePaused = false; this.touch(phase); } }, { ready: () => { clearTimeout(phase.startupTimer); phase.startupTimer = undefined; } }); }
        catch (error: unknown) { void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); }
      });
    }
    private frame(frame: NativeRecord) {
      this.control.observeInit(frame); if (this.control.handle(frame)) return;
      if (frame.type === "system" && frame.subtype === "init") {
        if (typeof frame.session_id !== "string" || this.sessionId && this.sessionId !== frame.session_id) throw new Error("Native session changed");
        this.sessionId = frame.session_id; this.initFrame = frame;
      }
      if (frame.type === "command_lifecycle" && this.control.qualified) {
        const started = ScheduledWakeupStatus.safeParse(frame);
        if (!this.phase && !this.scheduledCommandId && started.success && started.data.session_id === this.sessionId) {
          this.scheduledCommandId = started.data.command_uuid; return;
        }
        const completed = ScheduledCompletionStatus.safeParse(frame);
        if (completed.success && completed.data.session_id === this.sessionId && completed.data.command_uuid === this.scheduledCommandId) {
          this.scheduledCommandId = undefined;
          if (!this.phase) return;
        }
      }
      const request = nativeRecord(frame.request);
      if (frame.type === "control_request" && request?.subtype === "can_use_tool") {
        const id = nativeRef.safeParse(frame.request_id), toolId = nativeRef.safeParse(request.tool_use_id), name = nativeRef.safeParse(request.tool_name);
        const agent = nativeRef.optional().safeParse(request.agent_id), phase = this.phase;
        if (id.success && phase?.promptId && toolId.success && name.success && agent.success
          && this.jobs.ownsTool(toolId.data, name.data, this.sessionId!, agent.data)) { this.deliver(frame); return; }
        if (id.success) void this.control.respond(id.data, { behavior: "deny", message: "Native tool phase unavailable." })
          .finally(() => { if (!phase) return this.stop(new CanonicalCliError("invalid_output")); }).catch(reportNativeSessionFailure);
        else void this.stop(new CanonicalCliError("invalid_output")).catch(reportNativeSessionFailure);
        return;
      }
      if (frame.type === "control_request" && request?.subtype === "hook_callback") {
        const id = nativeRef.safeParse(frame.request_id);
        if (!id.success) throw new Error("Native callback unavailable");
        if (this.wireIds.has(id.data)) return;
        if (this.wireIds.size >= 4096) throw new Error("Native callback limit exceeded"); this.wireIds.add(id.data);
        if (request.callback_id === this.control.promptCallbackId) { this.prompt(frame, id.data); return; }
        if (request.callback_id === this.control.cronCallbackId || request.callback_id === this.control.bashCallbackId) { this.tool(frame, id.data); return; }
        void this.control.respond(id.data, { decision: "block", reason: "Native callback registration unavailable." }).catch(reportNativeSessionFailure); return;
      }
      if (!this.phase) {
        // Native status notifications and duplicate terminal receipts carry no model work.
        // Assistant/tool output (including unknown protocol frames) must have an admitted phase.
        if (!["system", "rate_limit_event", "result"].includes(frame.type as string)) {
          void this.stop(new CanonicalCliError("invalid_output")).catch(reportNativeSessionFailure);
        }
        return;
      }
      if (["assistant", "stream_event", "user"].includes(frame.type as string)
        && (!this.phase.promptId || !this.jobs.acceptsFrame(frame, this.sessionId!))) return;
      if (this.phase.promptId) this.jobs.handle(frame);
      if (frame.type === "result") this.phase.result = frame.is_error !== true && frame.subtype === "success";
      this.deliver(frame);
    }
    private prompt(frame: NativeRecord, id: string) {
      const parsed = PromptInput.safeParse(nativeRecord(frame.request)?.input);
      const block = () => this.control.respond(id, { decision: "block", reason: "Native scheduled phase unavailable." });
      if (!parsed.success || this.sessionId && parsed.data.session_id !== this.sessionId || this.prompts.has(parsed.data.prompt_id)) { void block().catch(reportNativeSessionFailure); return; }
      this.sessionId ??= parsed.data.session_id;
      if (this.prompts.size >= 4096) throw new Error("Native prompt limit exceeded"); this.prompts.add(parsed.data.prompt_id);
      if (this.phase) {
        if (this.phase.expectedPrompt !== parsed.data.prompt || this.phase.promptId) { void block().catch(reportNativeSessionFailure); return; }
        this.phase.promptId = parsed.data.prompt_id; void this.control.respond(id, {}).catch((error: unknown) => { reportNativeSessionFailure(error); void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); }); return;
      }
      const job = this.jobs.matches(parsed.data.prompt);
      if (!job || !this.eligible() || this.pendingPrompt || !handler) {
        void block().finally(() => this.stop(new CanonicalCliError("aborted"))).catch(reportNativeSessionFailure); return;
      }
      this.jobs.consume(job);
      const held: HeldPrompt = { id, promptId: parsed.data.prompt_id, prompt: parsed.data.prompt, timer: setTimeout(() => {
        if (this.pendingPrompt !== held) return; this.pendingPrompt = undefined;
        void block().finally(() => this.stop(new CanonicalCliError("timeout"))).catch(reportNativeSessionFailure);
      }, Math.min(120_000, controlMs * 3)) }; held.timer.unref?.(); this.pendingPrompt = held;
      const source = this.lastInput;
      void handler({ owner: source.owner, chatId: source.chatId, sourceRunId: source.runId, sessionId: this.sessionId!, promptId: held.promptId, prompt: held.prompt }).catch((error: unknown) => {
        reportNativeSessionFailure(error);
        if (this.pendingPrompt !== held) return; clearTimeout(held.timer); this.pendingPrompt = undefined;
        void block().finally(() => this.stop(new CanonicalCliError("aborted"))).catch(reportNativeSessionFailure);
      });
    }
    private tool(frame: NativeRecord, id: string) {
      const request = nativeRecord(frame.request), parsed = ToolInput.safeParse(request?.input), phase = this.phase;
      const deny = () => this.control.respond(id, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Native tool phase unavailable." } });
      if (!parsed.success || !phase?.promptId || parsed.data.session_id !== this.sessionId || parsed.data.prompt_id !== phase.promptId
        || request?.tool_use_id !== parsed.data.tool_use_id || !this.jobs.ownsTool(parsed.data.tool_use_id, parsed.data.tool_name, this.sessionId!, parsed.data.agent_id)) { void deny().catch(reportNativeSessionFailure); return; }
      if (request.callback_id === this.control.bashCallbackId) {
        if (parsed.data.tool_name !== "Bash" || parsed.data.agent_id !== undefined
          && !this.jobs.observesDelegatedBash(parsed.data.tool_use_id, parsed.data.agent_id, parsed.data.session_id, parsed.data.tool_input)) { void deny().catch(reportNativeSessionFailure); return; }
        const mapped = this.control.remapBash(frame);
        if (mapped) this.deliver(mapped); else void this.control.respond(id, {}).catch(reportNativeSessionFailure); return;
      }
      if (!["CronCreate", "CronDelete", "CronList"].includes(parsed.data.tool_name)) {
        void this.control.respond(id, {}).catch(reportNativeSessionFailure); return; // Keep native permission handling; this is no tool approval.
      }
      if (parsed.data.agent_id !== undefined) { void deny().catch(reportNativeSessionFailure); return; }
      const tool = this.jobs.toolInput(parsed.data.tool_use_id);
      if (!tool || JSON.stringify(tool.input) !== JSON.stringify(parsed.data.tool_input)) { void deny().catch(reportNativeSessionFailure); return; }
      if (parsed.data.tool_name === "CronCreate" && (!this.eligible() || !capacity(this) || !this.jobs.authorizeCreate(parsed.data.tool_use_id))) { void deny().catch(reportNativeSessionFailure); return; }
      if (parsed.data.tool_name === "CronCreate") this.reserved = true;
      void this.control.respond(id, {}).catch((error: unknown) => { reportNativeSessionFailure(error); void this.stop(new CanonicalCliError("startup")).catch(reportNativeSessionFailure); });
    }
    stop(error = new CanonicalCliError("aborted")): Promise<void> {
      if (this.physicalClosed) return this.closed;
      if (this.stopped) return this.closed;
      this.stopped = true; this.termination = error; this.control.close(); this.clearTimers();
      const kill = (signal: NodeJS.Signals) => {
        try { this.child.kill(signal); }
        catch (error: unknown) { console.warn("[claude-native] Process signal unavailable", error instanceof Error ? error.name : "UnknownError"); }
      };
      kill("SIGTERM");
      this.forceTimer = setTimeout(() => {
        if (this.physicalClosed) return; kill("SIGKILL");
        this.confirmTimer = setTimeout(() => {
          if (this.physicalClosed) return; this.lastInput.onCleanupUnconfirmed?.();
          const error = new Error("Native process cleanup unconfirmed"); this.finishPhase(error); this.rejectClosed(error);
        }, 250); this.confirmTimer.unref?.();
      }, 1000); this.forceTimer.unref?.();
      return this.closed;
    }
  }
  return {
    setScheduledHandler(value: ScheduledHandler) { if (closing) throw new Error("Native session pool closed"); handler = value; },
    async runTurn(turn: ClaudeNativeSessionTurnOptions): Promise<void> {
      if (closing || !turn.sourceFingerprint || turn.sourceFingerprint.length > 512) throw new Error("Native session unavailable");
      const key = sessionKey(turn.input); let session = sessions.get(key);
      const resume = nativeRecord(turn.input.resumeState)?.sessionId;
      if (session && (session.fingerprint !== turn.sourceFingerprint || !resume || resume !== session.sessionId)) {
        if (turn.input.nativeScheduled) {
          if (turn.input.nativeScheduled.sessionId === session.sessionId && turn.input.nativeScheduled.sourceRunId === session.lastInput.runId) await session.stop();
          throw new Error("Native scheduled source changed");
        }
        await session.stop(); session = undefined;
      }
      if (!session) {
        if (turn.input.nativeScheduled || sessions.size >= 160) throw new Error("Native session unavailable");
        session = new Session(turn); sessions.set(key, session);
      }
      await session.bind(turn);
    },
    async cancel(input: Pick<CanonicalProviderRunInput, "owner" | "chatId" | "runId">) {
      const session = sessions.get(sessionKey(input));
      if (session && (session.phase?.options.input.runId ?? session.lastInput.runId) === input.runId) await session.stop();
    },
    async retireIdle(input: Pick<CanonicalProviderRunInput, "owner" | "chatId">) {
      if (closing) throw new Error("Native session pool closed");
      const session = sessions.get(sessionKey(input));
      if (session?.phase) throw new Error("Native session busy");
      await session?.stop();
    },
    async close() {
      closing = true; const results = await Promise.allSettled([...sessions.values()].map(session => session.stop()));
      if (results.some(result => result.status === "rejected")) throw new Error("Native process cleanup unconfirmed");
    },
  };
}
export type ClaudeNativeSessionPool = ReturnType<typeof createClaudeNativeSessionPool>;
